//! Isolated-session worktree lifecycle (ADR 0329): create, resolve, merge,
//! remove, orphan cleanup, and startup reconciliation.
//!
//! The global `AppState` lock is held only for short registry reads and
//! writes, never across a Git command.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use serde::Serialize;
use tokio::sync::Mutex;

use super::git::GitRunner;
use super::merge::{self, MergeOutcome, MergePreview, SyncOutcome};
use super::probe::{probe, BRANCH_NAMESPACE};
use super::registry::{self, NewWorktree, SetupStatus, WorktreeRow, WorktreeStatus};
use super::remove::{is_real_dir, is_real_dir_chain, remove_worktree};
use super::{fnv1a64, repo_lock, WorktreeError};
use crate::db::Database;
use crate::sessions;
use crate::state::AppState;

pub type SharedState = Arc<Mutex<AppState>>;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludeReport {
    pub copied: Vec<String>,
    pub skipped_links: Vec<String>,
}

/// What the renderer needs to badge a session row; no filesystem paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSummary {
    pub branch: String,
    pub status: WorktreeStatus,
    pub setup_status: Option<SetupStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorktree {
    pub worktree: WorktreeSummary,
    pub included: IncludeReport,
    /// The main checkout had uncommitted changes that were not carried over.
    pub project_had_uncommitted_changes: bool,
}

/// Unmerged work that deleting the session would lose (delete confirmation).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingWork {
    pub unmerged_commits: u64,
    pub uncommitted_changes: bool,
}

pub fn worktrees_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("worktrees")
}

/// `<sanitized repository name>-<hash of its canonical path>`: readable, and
/// distinct for two repositories with the same folder name.
fn project_key(toplevel: &Path) -> String {
    let name: String = toplevel
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(24)
        .collect();
    let hash = fnv1a64(toplevel.to_string_lossy().as_bytes());
    format!(
        "{}-{:08x}",
        if name.is_empty() { "repo" } else { &name },
        hash as u32
    )
}

pub(super) fn short_id(id: &str) -> String {
    id.chars()
        .filter(char::is_ascii_alphanumeric)
        .take(12)
        .collect()
}

// ---- resolution (sync, called under the AppState lock) ----------------------

fn own_row(db: &Database, session_id: &str) -> Result<Option<WorktreeRow>, WorktreeError> {
    Ok(registry::for_owner(db, session_id, None)?)
}

/// The tool root of an isolated session, or `None` for every other session.
/// An isolated session never falls back to the main checkout.
pub fn tool_root(db: &Database, session_id: &str) -> Result<Option<PathBuf>, WorktreeError> {
    let Some(row) = own_row(db, session_id)? else {
        return Ok(None);
    };
    match row.status {
        WorktreeStatus::Creating => Err(WorktreeError::new(
            "WORKTREE_NOT_READY",
            "the isolated worktree is still being created",
        )),
        WorktreeStatus::Missing => Err(missing_error()),
        _ => {
            let root = row.workspace_root();
            if is_real_dir_chain(Path::new(&row.path), &row.prefix)
                && crate::workspace::simple_canonicalize(Path::new(&row.path))
                    .is_ok_and(|p| p == Path::new(&row.path))
            {
                Ok(Some(root))
            } else {
                Err(missing_error())
            }
        }
    }
}

pub(super) fn missing_error() -> WorktreeError {
    WorktreeError::new(
        "WORKTREE_MISSING",
        "the isolated worktree folder no longer exists; delete this session",
    )
}

/// Badges for the given sessions' own worktrees, keyed by session id.
pub fn summaries(db: &Database) -> Result<HashMap<String, WorktreeSummary>> {
    let mut statement = db.conn().prepare_cached(
        "SELECT session_id, branch, status, setup_status FROM worktrees
         WHERE session_id IS NOT NULL AND delegation_id IS NULL",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = HashMap::new();
    for (session_id, branch, status, setup) in rows {
        let Some(status) = parse_status(&status) else {
            continue;
        };
        out.insert(
            session_id,
            WorktreeSummary {
                branch,
                status,
                setup_status: setup.as_deref().and_then(parse_setup),
            },
        );
    }
    Ok(out)
}

fn parse_status(value: &str) -> Option<WorktreeStatus> {
    WorktreeStatus::parse(value).ok()
}

fn parse_setup(value: &str) -> Option<SetupStatus> {
    SetupStatus::parse(value).ok()
}

fn summary_of(row: &WorktreeRow) -> WorktreeSummary {
    WorktreeSummary {
        branch: row.branch.clone(),
        status: row.status,
        setup_status: row.setup_status,
    }
}

// ---- create -----------------------------------------------------------------

/// Refuse a branch name that already exists, so cleanup after a failed
/// creation never deletes a branch this call did not create.
pub(super) async fn ensure_branch_free(
    git: &GitRunner,
    repo_dir: &Path,
    branch: &str,
) -> Result<(), WorktreeError> {
    let taken = git
        .output(
            repo_dir,
            &["show-ref", "--verify", "--quiet", &merge::head_ref(branch)],
        )
        .await?
        .success();
    if taken {
        return Err(WorktreeError::new(
            "WORKTREE_PATH_EXISTS",
            format!("branch `{branch}` already exists"),
        ));
    }
    Ok(())
}

/// Undo a failed creation. The row (still `creating`) stays when cleanup
/// fails, so the startup or orphan pass retries it instead of leaving an
/// unrecorded directory and branch behind.
pub(super) async fn discard_failed_creation(
    state: &SharedState,
    git: &GitRunner,
    row: &WorktreeRow,
) {
    match remove_worktree(git, row).await {
        Ok(()) => {
            let st = state.lock().await;
            if let Err(error) = registry::remove(&st.db, &row.id) {
                tracing::warn!(%error, "could not unregister a failed worktree creation");
            }
        }
        Err(error) => {
            tracing::warn!(%error, path = %row.path, "could not clean up a failed worktree creation")
        }
    }
}

/// Create the session's own worktree from the project's current branch tip,
/// without copying uncommitted content or running setup commands.
pub async fn create_session_worktree(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
    project_path: &str,
) -> Result<CreatedWorktree, WorktreeError> {
    let project = Path::new(project_path);
    let repo = probe(git, project).await?;
    let project_had_uncommitted_changes = !merge::worktree_status(git, project).await?.is_empty();
    let _guard = repo_lock::lock(&repo.common_dir).await;

    let data_dir = state.lock().await.data_dir.clone();
    let parent = worktrees_dir(&data_dir).join(project_key(&repo.toplevel));
    std::fs::create_dir_all(&parent)?;
    let parent = crate::workspace::simple_canonicalize(&parent)?;
    let name = short_id(session_id);
    let root = parent.join(&name);
    if root.exists() {
        return Err(WorktreeError::new(
            "WORKTREE_PATH_EXISTS",
            format!("{} already exists", root.display()),
        ));
    }
    let branch = format!("{BRANCH_NAMESPACE}/{name}");
    ensure_branch_free(git, project, &branch).await?;
    let root_text = root.to_string_lossy().into_owned();
    let common_dir = repo.common_dir.to_string_lossy().into_owned();

    let row = {
        let st = state.lock().await;
        let port = None;
        registry::insert(
            &st.db,
            &NewWorktree {
                session_id,
                delegation_id: None,
                path: &root_text,
                common_dir: &common_dir,
                prefix: &repo.prefix,
                branch: &branch,
                owner_branch: &repo.branch,
                port_base: port,
            },
        )?
    };

    let created = async {
        git.run(
            project,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                &branch,
                &root_text,
                &merge::head_ref(&repo.branch),
            ],
        )
        .await?;
        git.run(
            &root,
            &[
                "worktree",
                "lock",
                "--reason",
                &format!("OMP Desktop session {session_id}"),
                &root_text,
            ],
        )
        .await?;
        if !is_real_dir_chain(&root, &repo.prefix) {
            return Err(missing_error());
        }
        Ok::<(), WorktreeError>(())
    }
    .await;
    if let Err(error) = created {
        discard_failed_creation(state, git, &row).await;
        return Err(error);
    }
    let present = {
        let st = state.lock().await;
        let present = sessions::session_summary(&st.db, session_id)?.is_some();
        if present {
            registry::set_status(&st.db, &row.id, WorktreeStatus::Active)?;
        }
        present
    };
    if !present {
        discard_failed_creation(state, git, &row).await;
        return Err(WorktreeError::new(
            "WORKTREE_NOT_ISOLATED",
            "session was deleted during creation",
        ));
    }
    let mut active = row;
    active.status = WorktreeStatus::Active;
    Ok(CreatedWorktree {
        worktree: summary_of(&active),
        included: IncludeReport::default(),
        project_had_uncommitted_changes,
    })
}

// ---- merge ------------------------------------------------------------------

struct MergeTarget {
    row: WorktreeRow,
    project_path: String,
    title: String,
}

async fn merge_target(state: &SharedState, session_id: &str) -> Result<MergeTarget, WorktreeError> {
    let st = state.lock().await;
    let row = own_row(&st.db, session_id)?.ok_or_else(|| {
        WorktreeError::new(
            "WORKTREE_NOT_ISOLATED",
            "the session has no isolated worktree",
        )
    })?;
    if row.status == WorktreeStatus::Creating {
        return Err(WorktreeError::new(
            "WORKTREE_NOT_READY",
            "the isolated worktree is still being created",
        ));
    }
    if row.status == WorktreeStatus::Missing || !is_real_dir(Path::new(&row.path)) {
        return Err(missing_error());
    }
    let summary = sessions::session_summary(&st.db, session_id)?
        .ok_or_else(|| WorktreeError::new("WORKTREE_NOT_ISOLATED", "session not found"))?;
    let project_path = summary
        .project_path
        .ok_or_else(|| WorktreeError::new("WORKTREE_NOT_ISOLATED", "the session has no project"))?;
    Ok(MergeTarget {
        row,
        project_path,
        title: summary.title,
    })
}

pub(super) fn ensure_idle(db: &Database, session_id: &str) -> Result<(), WorktreeError> {
    if sessions::session_has_running_turn(db, session_id)? {
        return Err(WorktreeError::new(
            "WORKTREE_BUSY",
            "the session is running; wait for it to finish",
        ));
    }
    Ok(())
}

/// Hold the session's own tools for the whole of a merge or sync: once no
/// tool of the session is in flight, every new Write, Edit, or Bash call of
/// it queues until the returned permit drops, so nothing can land between
/// the preview check, the checkpoint commit, and the merge. Taken after the
/// repo lock, the same order as the subagent merge-back.
pub(super) async fn hold_session(
    state: &SharedState,
    session_id: &str,
) -> Result<crate::tool_budget::SessionExclusivePermit, WorktreeError> {
    let budget = state.lock().await.tool_budget.clone();
    let permit = budget
        .acquire_session_exclusive(session_id, std::time::Duration::from_secs(5))
        .await
        .ok_or_else(|| {
            WorktreeError::new(
                "WORKTREE_BUSY",
                "a tool of the session is still running; wait for it to finish",
            )
        })?;
    // A turn may have started while this waited; its tools now queue, but a
    // running session is still not merged.
    ensure_idle(&state.lock().await.db, session_id)?;
    Ok(permit)
}

pub async fn preview_session(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
) -> Result<MergePreview, WorktreeError> {
    let target = merge_target(state, session_id).await?;
    merge::preview(git, &target.row).await
}

pub async fn merge_session(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
    preview_token: &str,
) -> Result<MergeOutcome, WorktreeError> {
    let target = merge_target(state, session_id).await?;
    ensure_idle(&state.lock().await.db, session_id)?;
    let _guard = repo_lock::lock(Path::new(&target.row.common_dir)).await;
    let _hold = hold_session(state, session_id).await?;
    // Checked again now that nothing of the session can run: the folder may
    // have been replaced while this waited for the locks.
    if !is_real_dir(Path::new(&target.row.path)) {
        return Err(missing_error());
    }
    let result = merge::merge(
        git,
        &target.row,
        Path::new(&target.project_path),
        &target.title,
        preview_token,
    )
    .await;
    let status = match &result {
        Ok(MergeOutcome::Merged { .. }) => Some(WorktreeStatus::Merged),
        Err(error) if error.code == "WORKTREE_CONFLICT" => Some(WorktreeStatus::Conflict),
        _ => None,
    };
    match status {
        Some(status) => {
            let st = state.lock().await;
            registry::set_status(&st.db, &target.row.id, status)?;
        }
        // A failure after the resolution was concluded (for example a dirty
        // project) must not leave a stale conflict badge.
        None if result.is_err() => {
            refresh_conflict_status(state, git, session_id).await;
        }
        None => {}
    }
    result
}

/// How many project commits "Sync from project" would bring in; for the
/// session menu.
pub async fn behind_session(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
) -> Result<u64, WorktreeError> {
    let target = merge_target(state, session_id).await?;
    // Opening the menu also picks up a conflict resolved outside the app.
    refresh_conflict_status(state, git, session_id).await;
    merge::commits_behind(git, &target.row).await
}

/// How many sessions `behind_all` checks at once.
const BEHIND_CONCURRENCY: usize = 8;

/// Result of `behind_all`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BehindCounts {
    pub counts: HashMap<String, u64>,
    /// A conflict badge was cleared (resolved outside the app), so the
    /// renderer should refresh its session list.
    pub statuses_changed: bool,
}

/// Project commits each isolated session lacks, keyed by session id, for the
/// sidebar's "behind" marker. Sessions whose count cannot be read (missing
/// folder, owner branch gone) are left out. Conflicted sessions are checked
/// for a resolution first. Runs git outside the state lock, a few sessions at
/// a time; the renderer calls it in the background, never while rendering.
pub async fn behind_all(
    state: &SharedState,
    git: &GitRunner,
) -> Result<BehindCounts, WorktreeError> {
    let rows = registry::all(&state.lock().await.db)?;
    let limit = Arc::new(tokio::sync::Semaphore::new(BEHIND_CONCURRENCY));
    let mut tasks = tokio::task::JoinSet::new();
    for row in rows {
        let Some(session_id) = row.session_id.clone() else {
            continue;
        };
        if row.delegation_id.is_some()
            || matches!(
                row.status,
                WorktreeStatus::Missing | WorktreeStatus::Creating
            )
            || !is_real_dir(Path::new(&row.path))
        {
            continue;
        }
        let (state, git, limit) = (state.clone(), git.clone(), limit.clone());
        tasks.spawn(async move {
            let _slot = limit.acquire_owned().await.ok();
            let cleared = row.status == WorktreeStatus::Conflict
                && refresh_conflict_status(&state, &git, &session_id).await;
            let count = merge::commits_behind(&git, &row).await.ok();
            (session_id, count, cleared)
        });
    }
    let mut result = BehindCounts::default();
    while let Some(joined) = tasks.join_next().await {
        let Ok((session_id, count, cleared)) = joined else {
            continue;
        };
        result.statuses_changed |= cleared;
        if let Some(count) = count {
            result.counts.insert(session_id, count);
        }
    }
    Ok(result)
}

/// "Sync from project" (ADR 0329): merge the project's branch into the
/// session's worktree so the session continues on current code. The project
/// checkout is never touched; a conflict stays in the worktree and marks the
/// session, exactly like a merge into the project.
pub async fn sync_session(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
) -> Result<SyncOutcome, WorktreeError> {
    let target = merge_target(state, session_id).await?;
    ensure_idle(&state.lock().await.db, session_id)?;
    let _guard = repo_lock::lock(Path::new(&target.row.common_dir)).await;
    let _hold = hold_session(state, session_id).await?;
    if !is_real_dir(Path::new(&target.row.path)) {
        return Err(missing_error());
    }
    let result =
        merge::sync_from_owner(git, &target.row, &merge::commit_message(&target.title)).await;
    let status = match &result {
        Ok(_) => WorktreeStatus::Active,
        Err(error) if error.code == "WORKTREE_CONFLICT" => WorktreeStatus::Conflict,
        Err(_) => {
            refresh_conflict_status(state, git, session_id).await;
            return result;
        }
    };
    let st = state.lock().await;
    registry::set_status(&st.db, &target.row.id, status)?;
    result
}

/// After the session's own Write/Edit/Bash call: clear a `conflict` badge
/// once the agent resolved every conflict (the merge itself still concludes
/// on "Merge into project") or abandoned the merge. Cheap for every other
/// session: one registry read, no git. Failures only log; the badge then
/// stays until the next merge attempt.
///
/// Returns whether the status was cleared.
pub async fn refresh_conflict_status(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
) -> bool {
    let row = match registry::for_owner(&state.lock().await.db, session_id, None) {
        Ok(Some(row)) if row.status == WorktreeStatus::Conflict => row,
        Ok(_) => return false,
        Err(error) => {
            tracing::warn!(%error, "could not read the worktree registry");
            return false;
        }
    };
    let root = Path::new(&row.path);
    if !is_real_dir(root) {
        return false;
    }
    let settled = async {
        Ok::<bool, WorktreeError>(
            !merge::merge_in_progress(git, root).await?
                || merge::conflicts_resolved(git, root).await?,
        )
    }
    .await;
    match settled {
        Ok(true) => {
            let st = state.lock().await;
            match registry::clear_conflict(&st.db, &row.id) {
                // `false` when a concurrent merge or sync changed it meanwhile.
                Ok(cleared) => cleared,
                Err(error) => {
                    tracing::warn!(%error, "could not clear the worktree conflict status");
                    false
                }
            }
        }
        Ok(false) => false,
        Err(error) => {
            tracing::warn!(%error, path = %row.path, "could not check worktree conflicts");
            false
        }
    }
}

pub use super::maintenance::{pending_work, reconcile, remove_session_worktrees};
