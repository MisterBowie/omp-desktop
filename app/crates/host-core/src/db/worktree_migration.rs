use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// Registry of git worktrees that host-core created for isolated sessions and
/// their Write/Edit delegates (ADR 0329).
///
/// `session_id` uses `ON DELETE SET NULL`, not `CASCADE`: a session removed by
/// any path leaves an orphan row that the cleanup pass turns into a link-safe
/// removal of the directory and branch. A cascade would drop the only record
/// of a worktree that still exists on disk.
///
/// Shared verbatim by the fresh schema and the v21 -> v22 migration;
/// `IF NOT EXISTS` keeps a second run harmless.
pub(crate) const WORKTREE_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS worktrees (
  id             TEXT PRIMARY KEY,
  session_id     TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  delegation_id  TEXT,
  path           TEXT NOT NULL UNIQUE,
  -- Canonical common git directory: serialization key, and where branches are
  -- deleted after the worktree directory is gone.
  common_dir     TEXT NOT NULL,
  -- Project directory relative to the repository top level ('' at the top).
  prefix         TEXT NOT NULL DEFAULT '',
  branch         TEXT NOT NULL,
  owner_branch   TEXT NOT NULL,
  status         TEXT NOT NULL
                 CHECK (status IN ('creating', 'active', 'conflict', 'merged', 'missing')),
  setup_status   TEXT
                 CHECK (setup_status IS NULL
                        OR setup_status IN ('none', 'running', 'ok', 'failed')),
  setup_log      TEXT,
  port_base      INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worktrees_session_delegation
  ON worktrees(session_id, IFNULL(delegation_id, ''))
  WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_worktrees_port_base
  ON worktrees(port_base) WHERE port_base IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_worktrees_orphans
  ON worktrees(updated_at) WHERE session_id IS NULL;
"#;

fn migrate_v21_to_v22_tx(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(WORKTREE_DDL)?;
    tx.pragma_update(None, "user_version", 22i64)?;
    Ok(())
}

pub(crate) fn migrate_v21_to_v22(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 21)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v21_to_v22_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v21 to v22 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
