//! `worktree.*` methods and the isolated-session hooks of `session.create` and
//! `session.delete` (ADR 0329). Callers name a session or a project; no
//! method accepts a worktree path.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, JsonRpcError};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::{lifecycle, merge, probe, registry, WorktreeError};
use crate::sessions;
use crate::state::AppState;

/// Numeric JSON-RPC code shared by every `WORKTREE_*` error; `errorCode`
/// carries the specific reason.
const WORKTREE_RPC_CODE: i64 = 1025;

pub(super) fn to_rpc(error: WorktreeError) -> JsonRpcError {
    let mut data = json!({ "errorCode": error.code });
    if !error.files.is_empty() {
        data["files"] = json!(error.files);
    }
    JsonRpcError {
        code: WORKTREE_RPC_CODE,
        message: error.message,
        data: Some(data),
    }
}

/// Isolation needs an explicit local checkout, never the host's process cwd.
pub(super) fn ensure_absolute_project(project_path: &str) -> Result<(), JsonRpcError> {
    if !Path::new(project_path).is_absolute() {
        return Err(rpc_err(
            1002,
            "an isolated session needs an absolute local project path",
            "INVALID_PARAMS",
        ));
    }
    Ok(())
}

fn str_param<'a>(params: &'a Value, name: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| rpc_err(1002, format!("{name} required"), "INVALID_PARAMS"))
}

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let git = GitRunner::default();
    match method {
        // Whether a project can host isolated sessions, for the create switch
        // (PRD R6) and the "uncommitted changes are not included" notice (R2b).
        "worktree.probe" => {
            let project = str_param(&params, "projectPath")?;
            if let Err(error) = ensure_absolute_project(project) {
                let data = error.data.unwrap_or_default();
                return Ok(json!({
                    "available": false,
                    "errorCode": data["errorCode"],
                    "message": error.message,
                }));
            }
            match probe::probe(&git, Path::new(project)).await {
                Ok(_) => {
                    let dirty = !merge::worktree_status(&git, Path::new(project))
                        .await
                        .map_err(to_rpc)?
                        .is_empty();
                    Ok(json!({ "available": true, "uncommittedChanges": dirty }))
                }
                Err(error) => Ok(json!({
                    "available": false,
                    "errorCode": error.code(),
                    "message": error.to_string(),
                })),
            }
        }
        "worktree.preview" => {
            let session_id = str_param(&params, "sessionId")?;
            let preview = lifecycle::preview_session(state, &git, session_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "preview": preview }))
        }
        "worktree.merge" => {
            let session_id = str_param(&params, "sessionId")?;
            let token = str_param(&params, "previewToken")?;
            let outcome = lifecycle::merge_session(state, &git, session_id, token)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "outcome": outcome }))
        }
        // "Sync from project": `behind` sizes the menu item, `sync` merges
        // the project's branch into the session worktree.
        "worktree.behind" => {
            let session_id = str_param(&params, "sessionId")?;
            let commits = lifecycle::behind_session(state, &git, session_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "commits": commits }))
        }
        "worktree.behindAll" => {
            let behind = lifecycle::behind_all(state, &git).await.map_err(to_rpc)?;
            Ok(json!(behind))
        }
        "worktree.sync" => {
            let session_id = str_param(&params, "sessionId")?;
            let outcome = lifecycle::sync_session(state, &git, session_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "outcome": outcome }))
        }
        "worktree.pendingWork" => {
            let session_id = str_param(&params, "sessionId")?;
            let pending = lifecycle::pending_work(state, &git, session_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "pending": pending }))
        }
        "worktree.setupLog" => {
            let session_id = str_param(&params, "sessionId")?;
            let st = state.lock().await;
            let row = registry::for_owner(&st.db, session_id, None)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({
                "setupStatus": row.as_ref().and_then(|row| row.setup_status),
                "log": row.and_then(|row| row.setup_log),
            }))
        }
        // For Electron Main's "Reveal in folder" only; never forwarded to
        // the renderer.
        "worktree.location" => {
            let session_id = str_param(&params, "sessionId")?;
            let st = state.lock().await;
            let root = lifecycle::tool_root(&st.db, session_id)
                .map_err(to_rpc)?
                .ok_or_else(|| {
                    to_rpc(WorktreeError::new(
                        "WORKTREE_NOT_ISOLATED",
                        "the session has no isolated worktree",
                    ))
                })?;
            Ok(json!({ "path": root }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

/// Give a just-created session its worktree. On failure the session is
/// deleted again, so no half-created isolated session remains (design §5.1).
pub(super) async fn isolate_new_session(
    state: &Arc<Mutex<AppState>>,
    session_id: &str,
    project_path: &str,
) -> Result<lifecycle::CreatedWorktree, JsonRpcError> {
    match lifecycle::create_session_worktree(state, &GitRunner::default(), session_id, project_path)
        .await
    {
        Ok(created) => Ok(created),
        Err(error) => {
            let st = state.lock().await;
            if let Err(cleanup) = sessions::delete_session(&st.db, session_id) {
                tracing::warn!(%cleanup, "could not delete a session whose worktree failed");
            }
            Err(to_rpc(error))
        }
    }
}

/// Remove an isolated session's worktrees and branches before the session row
/// is deleted. A failure keeps the session (nothing is half-removed silently).
pub(super) async fn remove_before_delete(
    state: &Arc<Mutex<AppState>>,
    session_id: &str,
) -> Result<(), JsonRpcError> {
    let has_worktrees = {
        let st = state.lock().await;
        !registry::for_session(&st.db, session_id)
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            .is_empty()
    };
    if !has_worktrees {
        return Ok(());
    }
    lifecycle::remove_session_worktrees(state, &GitRunner::default(), session_id)
        .await
        .map_err(to_rpc)
}

#[cfg(test)]
mod tests;
