//! Registry-owned removal, pending-work inspection and startup recovery.
use super::git::GitRunner;
use super::lifecycle::{ensure_idle, hold_session, short_id, PendingWork, SharedState};
use super::probe::BRANCH_NAMESPACE;
use super::registry::{self, WorktreeRow, WorktreeStatus};
use super::remove::{is_real_dir, remove_worktree};
use super::{merge, repo_lock, WorktreeError};
use std::path::Path;

// ---- remove -----------------------------------------------------------------

/// Commits on `row`'s branch that its owner branch lacks. When the owner
/// branch is gone, counts commits no other local branch has, so the delete
/// confirmation never reports lost work as zero. Runs in the repository, so
/// it also works when the worktree folder vanished.
pub(super) async fn unmerged_commits(
    git: &GitRunner,
    row: &WorktreeRow,
) -> Result<u64, WorktreeError> {
    let common_dir = Path::new(&row.common_dir);
    let branch = merge::head_ref(&row.branch);
    let branch_exists = git
        .run_git_dir(common_dir, &["show-ref", "--verify", "--quiet", &branch])
        .await
        .is_ok();
    if !branch_exists {
        return Ok(0);
    }
    let range = format!("{}..{}", merge::head_ref(&row.owner_branch), branch);
    let count = match git
        .run_git_dir(common_dir, &["rev-list", "--count", &range])
        .await
    {
        Ok(count) => count,
        Err(_) => {
            // Every branch of this session (its own and its subagents') goes
            // away with it, so none of them may count as keeping the work.
            let mut args = vec![
                "rev-list".to_string(),
                "--count".to_string(),
                branch.clone(),
                "--not".to_string(),
            ];
            args.push(format!("--exclude={}", row.branch));
            if let Some(session_id) = row.session_id.as_deref() {
                let session_branch = format!("{BRANCH_NAMESPACE}/{}", short_id(session_id));
                args.push(format!("--exclude={session_branch}"));
                args.push(format!("--exclude={session_branch}-*"));
            }
            args.push("--branches".to_string());
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            git.run_git_dir(common_dir, &args).await?
        }
    };
    count.trim().parse().map_err(|_| {
        WorktreeError::new(
            "WORKTREE_GIT_FAILED",
            format!("unexpected rev-list output: {}", count.trim()),
        )
    })
}

/// Unmerged commits and uncommitted changes across every worktree of the
/// session, for the delete confirmation.
pub async fn pending_work(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
) -> Result<PendingWork, WorktreeError> {
    let rows = registry::for_session(&state.lock().await.db, session_id)?;
    let mut pending = PendingWork::default();
    for row in rows {
        // Counted from the repository, so a vanished folder whose branch
        // still holds commits is still reported before it is deleted.
        pending.unmerged_commits += unmerged_commits(git, &row).await?;
        let root = Path::new(&row.path);
        if is_real_dir(root) && !merge::worktree_status(git, root).await?.is_empty() {
            pending.uncommitted_changes = true;
        }
    }
    Ok(pending)
}

/// Remove every worktree and branch of a session (delete = discard, PRD R5).
/// Stops at the first failure so the session and the remaining rows stay.
pub async fn remove_session_worktrees(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
) -> Result<(), WorktreeError> {
    let rows = {
        let st = state.lock().await;
        ensure_idle(&st.db, session_id)?;
        let rows = registry::for_session(&st.db, session_id)?;
        if rows
            .iter()
            .any(|row| row.status == WorktreeStatus::Creating)
        {
            return Err(WorktreeError::new(
                "WORKTREE_NOT_READY",
                "the isolated worktree is still being created",
            ));
        }
        rows
    };
    for row in rows.iter().rev() {
        remove_row(state, git, row).await?;
    }
    Ok(())
}

async fn remove_row(
    state: &SharedState,
    git: &GitRunner,
    row: &WorktreeRow,
) -> Result<(), WorktreeError> {
    let _guard = repo_lock::lock(Path::new(&row.common_dir)).await;
    let _hold = if let Some(session_id) = row.session_id.as_deref() {
        Some(hold_session(state, session_id).await?)
    } else {
        None
    };
    remove_worktree(git, row).await?;
    let st = state.lock().await;
    registry::remove(&st.db, &row.id)?;
    Ok(())
}

/// Remove worktrees whose session was deleted by any path (ON DELETE SET
/// NULL). Returns how many were removed; failures stay for the next pass.
pub async fn cleanup_orphans(state: &SharedState, git: &GitRunner) -> usize {
    let orphans = match registry::orphans(&state.lock().await.db) {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, "could not list orphaned worktrees");
            return 0;
        }
    };
    let mut removed = 0;
    for row in orphans {
        match remove_row(state, git, &row).await {
            Ok(()) => removed += 1,
            Err(error) => {
                tracing::warn!(%error, path = %row.path, "could not remove an orphaned worktree")
            }
        }
    }
    removed
}

/// Startup pass: drop half-created worktrees, mark vanished ones missing,
/// repair git's links after a moved data directory, and clean orphans.
pub async fn reconcile(state: SharedState, git: GitRunner) {
    let rows = match registry::all(&state.lock().await.db) {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, "could not read the worktree registry");
            return;
        }
    };
    for row in rows {
        if row.session_id.is_none() {
            continue;
        }
        if row.status == WorktreeStatus::Creating {
            let _guard = repo_lock::lock(Path::new(&row.common_dir)).await;
            if let Err(error) = remove_worktree(&git, &row).await {
                tracing::warn!(%error, "could not clean incomplete worktree");
            }
            let _ = registry::set_status(&state.lock().await.db, &row.id, WorktreeStatus::Missing);
            continue;
        }
        let root = Path::new(&row.path);
        if !is_real_dir(root) {
            let st = state.lock().await;
            let _ = registry::set_status(&st.db, &row.id, WorktreeStatus::Missing);
            continue;
        }
        let common_dir = Path::new(&row.common_dir);
        if common_dir.is_dir() {
            let _guard = repo_lock::lock(common_dir).await;
            if let Err(error) = git
                .run_git_dir(common_dir, &["worktree", "repair", &row.path])
                .await
            {
                tracing::warn!(%error, path = %row.path, "git worktree repair failed");
            }
        }
    }
    cleanup_orphans(&state, &git).await;
}
