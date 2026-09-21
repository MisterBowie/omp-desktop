use super::*;

/// v16 → v17: `providers.owner_plugin_id`, the ownership column that keeps a
/// plugin-declared provider row apart from the user's own rows (ADR 0259).
/// Additive — every existing row is a user row and keeps a NULL owner.
pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    create_migration_backup(conn, path, 16)?;
    let tx = conn.unchecked_transaction()?;
    let has_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('providers') WHERE name = 'owner_plugin_id')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        tx.execute_batch("ALTER TABLE providers ADD COLUMN owner_plugin_id TEXT;")?;
    }
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_providers_owner ON providers(owner_plugin_id)
           WHERE owner_plugin_id IS NOT NULL;",
    )?;
    // Every pre-v17 row belongs to the user: a plugin-declared provider did not
    // exist before this version, so there is nothing to adopt.
    tx.pragma_update(None, "user_version", 17)?;
    tx.commit()
        .context("commit plugin provider ownership migration")?;
    Ok(())
}
