//! Plan/Goal × Cursor write guard (M5/T20-R3C, ADR 0306).
//!
//! The product decision this module enforces: a session may not combine the
//! Cursor provider with Plan or Goal mode. Cursor's exec channel runs tool calls
//! while a response is still streaming — before the assistant message that
//! carries them exists — so PI's transition-tool contract cannot be honoured for
//! a Cursor-backed session and its effects cannot be undone
//! (`docs/validation/M5-omp-transition-patch.md` §9/§10). Plan/Goal therefore
//! does not support Cursor models.
//!
//! Why the guard is here and not in a caller:
//!
//! * PI Desktop has no mode↔model gate anywhere — its mode gates read session
//!   *state* and its model gates read *configuration* (`upstream/pi-desktop`),
//!   so this is a new concept and has to sit at the narrowest true boundary.
//! * The pinned runtime identifies Cursor by the canonical provider id
//!   `"cursor"` (`packages/catalog/src/compat/provider-ids.ts`,
//!   `.../rules/providers/cursor.kdl`); the desktop's own model lists cannot
//!   even express that provider today, so a caller-side check is both avoidable
//!   and easy to bypass.
//! * Every durable writer of `sessions.mode`/`provider_id` — the transition tool
//!   (`plans.enter`), the configuration RPC, session creation, forks, imports
//!   and any future caller — goes through the two triggers installed here on the
//!   one connection [`Database`] owns. Refusing the *write itself* closes the
//!   window a pre-read leaves open: the condition is evaluated by SQLite against
//!   the row as it is written, so an update that races another writer cannot
//!   land on the refused pair.
//! * The triggers are **TEMP** triggers: they exist only for that connection and
//!   die with it. Nothing about the guard is persisted, no schema version moves,
//!   and a downgrade cannot inherit it (see [`install`]).
//!
//! What the guard deliberately does **not** do:
//!
//! * It never rewrites a user's mode or model. A refused write leaves the
//!   previous state in place, and both repairs (drop the mode, or choose
//!   another provider) are ordinary writes that pass.
//! * It does not fight pre-existing data. A database that already holds the pair
//!   (hand-edited, or migrated from an older build) keeps opening, and unrelated
//!   writes to that row still work; only a *transition into* the pair is
//!   refused. The desktop's prompt gate remains the last line of defence for
//!   such rows.
//! * It does not constrain a raw `sqlite3` connection. TEMP triggers are
//!   per-connection, so a manual edit outside the host writes the pair freely —
//!   that is the pre-existing-data case above, and the prompt gate covers it.

use crate::db::{Database, Result};

/// The provider id the pinned runtime uses for Cursor. Detection is an exact
/// comparison on this id — never a display label, a user-typed vendor hint, or
/// an endpoint URL. The TypeScript predicate
/// (`packages/shared/src/plan-goal-model-gate.ts`) and this constant are pinned
/// together by `apps/desktop/test/plan-goal-cursor-constant-parity.test.mjs`.
pub const CURSOR_PROVIDER_ID: &str = "cursor";

/// The stable refusal code, shared with the desktop's `ErrorCodes` registry.
/// The guard's message is exactly this code, matching how the plan refusals
/// (`PLAN_CONFIGURATION_BLOCKED`, `PLAN_ALREADY_ACTIVE`) already travel, so
/// `plan_rpc_err` reports it verbatim on every RPC that can write the pair.
pub const PLAN_GOAL_CURSOR_UNSUPPORTED: &str = "PLAN_GOAL_CURSOR_UNSUPPORTED";

/// Install the write guards on the connection `db` owns. Called once per
/// `Database::open`, before any writer can reach the table.
///
/// Both guards are TEMP triggers: they belong to this connection's temp schema
/// and disappear with it. They never enter `sqlite_master`, so no schema-version
/// migration is involved and an older binary opening the same file afterwards
/// inherits no behaviour it does not understand. Installing first drops every
/// same-named definition the connection or the file may already hold — including
/// the durable triggers commit `876fb07` wrote into `sqlite_master` — so the
/// current text always wins. TEMP triggers are connection-scoped state: a write
/// made through a raw `sqlite3` connection (a manual edit) is outside them, and
/// stays the desktop prompt gate's job.
pub(crate) fn install(db: &Database) -> Result<()> {
    db.conn()
        .execute_batch(&format!("{}{}", clear_sql(), guard_sql()))?;
    Ok(())
}

/// The two trigger names this module owns. A durable trigger and a TEMP trigger
/// of the same name are distinct objects in different schemas, so every
/// statement names its schema explicitly.
const GUARD_TRIGGER_NAMES: [&str; 2] = [
    "sessions_refuse_cursor_contract_ai",
    "sessions_refuse_cursor_contract_au",
];

/// `DROP TRIGGER IF EXISTS` for both names in both schemas: the durable ones an
/// earlier build could have left in `sqlite_master`, and this connection's TEMP
/// ones. A bare name would resolve to only one of the two.
fn clear_sql() -> String {
    let mut sql = String::new();
    for name in GUARD_TRIGGER_NAMES {
        sql.push_str(&format!("DROP TRIGGER IF EXISTS main.{name};\n"));
        sql.push_str(&format!("DROP TRIGGER IF EXISTS temp.{name};\n"));
    }
    sql
}

/// The guard text, built from the constants so the provider id and the refusal
/// code cannot drift from the values callers compare against.
///
/// The update guard refuses *every* write that would leave the pair behind,
/// with a single exemption: a row that already holds it may be updated as long
/// as both guarded columns keep exactly their previous values. That keeps
/// unrelated maintenance (a rename, a thinking level, another model) working on
/// pre-existing data without letting a legacy row hop to the other contract
/// mode — `plan` + Cursor becoming `goal` + Cursor is a transition into the
/// pair, not a stale row being tolerated.
///
/// `CREATE TEMP TRIGGER` with no `IF NOT EXISTS` on purpose: the caller clears
/// the names first, so a revision of this text always replaces the previous
/// definition instead of being skipped as already present.
fn guard_sql() -> String {
    format!(
        r#"
CREATE TEMP TRIGGER sessions_refuse_cursor_contract_ai
  BEFORE INSERT ON main.sessions
  WHEN new.mode IN ('plan', 'goal') AND new.provider_id = '{provider}'
  BEGIN SELECT RAISE(ABORT, '{code}'); END;

CREATE TEMP TRIGGER sessions_refuse_cursor_contract_au
  BEFORE UPDATE OF mode, provider_id ON main.sessions
  WHEN new.mode IN ('plan', 'goal') AND new.provider_id = '{provider}'
   AND NOT (old.mode = new.mode AND old.provider_id = new.provider_id)
  BEGIN SELECT RAISE(ABORT, '{code}'); END;
"#,
        provider = CURSOR_PROVIDER_ID,
        code = PLAN_GOAL_CURSOR_UNSUPPORTED,
    )
}

/// Test-only: remove the guards (TEMP and any durable residual) so a fixture can
/// plant the row an upgraded or hand-edited database may already hold.
/// Re-install with [`install`].
#[cfg(test)]
pub(crate) fn uninstall(db: &Database) -> Result<()> {
    db.conn().execute_batch(&clear_sql())?;
    Ok(())
}

/// Test-only: plant a session that holds the refused pair, as a pre-guard
/// database could, and restore the guard afterwards.
#[cfg(test)]
pub(crate) fn plant_legacy_contract_cursor_session(db: &Database, id: &str) -> Result<()> {
    uninstall(db)?;
    db.conn().execute(
        "INSERT INTO sessions (
            id, title, provider_id, model_id, mode, thinking_level, permission_mode,
            engine, created_at, updated_at
         ) VALUES (?1, 'Legacy', ?2, 'claude-4.6-opus-high', 'plan', 'off', 'inherit',
                   'pi', 1, 1)",
        rusqlite::params![id, CURSOR_PROVIDER_ID],
    )?;
    install(db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{now_ms, Connection};
    use rusqlite::params;

    /// The persistent trigger text `876fb07` wrote into the durable schema.
    /// Reproduced verbatim so the upgrade test plants exactly the residual that
    /// build leaves behind in `sqlite_master`.
    const LEGACY_PERSISTENT_GUARD_SQL: &str = r#"
CREATE TRIGGER IF NOT EXISTS sessions_refuse_cursor_contract_ai
  BEFORE INSERT ON sessions
  WHEN new.mode IN ('plan', 'goal') AND new.provider_id = 'cursor'
  BEGIN SELECT RAISE(ABORT, 'PLAN_GOAL_CURSOR_UNSUPPORTED'); END;

CREATE TRIGGER IF NOT EXISTS sessions_refuse_cursor_contract_au
  BEFORE UPDATE OF mode, provider_id ON sessions
  WHEN new.mode IN ('plan', 'goal') AND new.provider_id = 'cursor'
   AND NOT (old.mode = new.mode AND old.provider_id = new.provider_id)
  BEGIN SELECT RAISE(ABORT, 'PLAN_GOAL_CURSOR_UNSUPPORTED'); END;
"#;

    fn test_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    /// Trigger names in one sqlite schema: `sqlite_master` is the durable file,
    /// `sqlite_temp_master` this connection's TEMP objects only.
    fn trigger_names(conn: &Connection, master: &str) -> Vec<String> {
        conn.prepare(&format!(
            "SELECT name FROM {master} WHERE type = 'trigger' ORDER BY name"
        ))
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
    }

    fn guard_trigger_names(conn: &Connection, master: &str) -> Vec<String> {
        trigger_names(conn, master)
            .into_iter()
            .filter(|name| name.starts_with("sessions_refuse_cursor_contract_"))
            .collect()
    }

    fn trigger_sql(conn: &Connection, master: &str, name: &str) -> String {
        conn.query_row(
            &format!("SELECT sql FROM {master} WHERE name = ?1"),
            params![name],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn insert_session_on(
        conn: &Connection,
        id: &str,
        mode: &str,
        provider: Option<&str>,
    ) -> Result<usize> {
        Ok(conn.execute(
            "INSERT INTO sessions (
                id, title, provider_id, model_id, mode, thinking_level, permission_mode,
                engine, created_at, updated_at
             ) VALUES (?1, 'Guarded', ?2, 'm', ?3, 'off', 'inherit', 'pi', ?4, ?4)",
            params![id, provider, mode, now_ms()],
        )?)
    }

    fn insert_session(
        db: &Database,
        id: &str,
        mode: &str,
        provider: Option<&str>,
    ) -> Result<usize> {
        insert_session_on(db.conn(), id, mode, provider)
    }

    #[test]
    fn the_guards_are_connection_scoped_temp_triggers() {
        let (_dir, db) = test_db();
        assert_eq!(
            guard_trigger_names(db.conn(), "sqlite_temp_master"),
            vec![
                "sessions_refuse_cursor_contract_ai".to_string(),
                "sessions_refuse_cursor_contract_au".to_string(),
            ]
        );
        // The durable schema must stay clean: an older binary (or a manual
        // sqlite3 session) opening the same file later must not inherit a guard
        // it does not understand.
        assert!(guard_trigger_names(db.conn(), "sqlite_master").is_empty());
        // Both guards are TEMP triggers on the main database's table, so they
        // exist only for the connection that installed them (SQLite records them
        // in `sqlite_temp_master`, and normalizes the stored text to
        // `CREATE TRIGGER`, so the schema it was found in is the evidence).
        for name in [
            "sessions_refuse_cursor_contract_ai",
            "sessions_refuse_cursor_contract_au",
        ] {
            let sql = trigger_sql(db.conn(), "sqlite_temp_master", name);
            assert!(sql.contains("ON main.sessions"), "{sql}");
            assert!(
                sql.contains(&format!("RAISE(ABORT, '{PLAN_GOAL_CURSOR_UNSUPPORTED}')")),
                "{sql}"
            );
        }
    }

    #[test]
    fn the_guards_die_with_the_connection_and_return_on_the_next_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        drop(Database::open(&path).unwrap());

        // A raw connection — a manual edit, or a downgraded binary — sees no
        // guard at all: TEMP triggers never entered the file.
        let raw = Connection::open(&path).unwrap();
        assert!(guard_trigger_names(&raw, "sqlite_temp_master").is_empty());
        assert!(guard_trigger_names(&raw, "sqlite_master").is_empty());
        // That write is the manual-edit path the desktop's prompt gate covers;
        // the guard deliberately makes no claim about raw connections.
        insert_session_on(&raw, "manual-plan-cursor", "plan", Some(CURSOR_PROVIDER_ID)).unwrap();
        drop(raw);

        // The next host open installs the guards again and refuses the pair on
        // the row as it is written.
        let db = Database::open(&path).unwrap();
        assert_eq!(
            guard_trigger_names(db.conn(), "sqlite_temp_master").len(),
            2
        );
        assert_eq!(
            insert_session(&db, "guarded", "plan", Some(CURSOR_PROVIDER_ID))
                .unwrap_err()
                .to_string(),
            PLAN_GOAL_CURSOR_UNSUPPORTED
        );
    }

    #[test]
    fn install_replaces_the_persistent_triggers_an_older_build_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        drop(Database::open(&path).unwrap());
        {
            let raw = Connection::open(&path).unwrap();
            raw.execute_batch(LEGACY_PERSISTENT_GUARD_SQL).unwrap();
            assert_eq!(guard_trigger_names(&raw, "sqlite_master").len(), 2);
        }

        let db = Database::open(&path).unwrap();
        // The residual `876fb07` trigger is gone from the durable schema, the
        // current definition is installed as a TEMP trigger, and it still
        // refuses the pair.
        assert!(guard_trigger_names(db.conn(), "sqlite_master").is_empty());
        assert_eq!(
            guard_trigger_names(db.conn(), "sqlite_temp_master"),
            vec![
                "sessions_refuse_cursor_contract_ai".to_string(),
                "sessions_refuse_cursor_contract_au".to_string(),
            ]
        );
        assert_eq!(
            insert_session(&db, "guarded", "plan", Some(CURSOR_PROVIDER_ID))
                .unwrap_err()
                .to_string(),
            PLAN_GOAL_CURSOR_UNSUPPORTED
        );
    }

    #[test]
    fn install_replaces_a_stale_connection_definition_instead_of_keeping_it() {
        let (_dir, db) = test_db();
        uninstall(&db).unwrap();
        // A stale definition that no longer refuses: install must drop it and
        // install the current text (a leftover `IF NOT EXISTS` would silently
        // keep this one, and a future revision would never replace it).
        db.conn()
            .execute_batch(
                "CREATE TEMP TRIGGER sessions_refuse_cursor_contract_ai
                   BEFORE INSERT ON main.sessions
                   BEGIN SELECT 1; END;
                 CREATE TEMP TRIGGER sessions_refuse_cursor_contract_au
                   BEFORE UPDATE OF mode, provider_id ON main.sessions
                   BEGIN SELECT 1; END;",
            )
            .unwrap();
        insert_session(&db, "unguarded", "plan", Some(CURSOR_PROVIDER_ID)).unwrap();
        db.conn()
            .execute("DELETE FROM sessions WHERE id = 'unguarded'", [])
            .unwrap();

        install(&db).unwrap();
        let sql = trigger_sql(
            db.conn(),
            "sqlite_temp_master",
            "sessions_refuse_cursor_contract_ai",
        );
        assert!(!sql.contains("SELECT 1"), "{sql}");
        assert!(sql.contains("RAISE(ABORT"), "{sql}");
        assert_eq!(
            insert_session(&db, "guarded", "plan", Some(CURSOR_PROVIDER_ID))
                .unwrap_err()
                .to_string(),
            PLAN_GOAL_CURSOR_UNSUPPORTED
        );
    }

    #[test]
    fn uninstall_leaves_no_guard_in_either_schema() {
        let (_dir, db) = test_db();
        uninstall(&db).unwrap();
        assert!(guard_trigger_names(db.conn(), "sqlite_temp_master").is_empty());
        assert!(guard_trigger_names(db.conn(), "sqlite_master").is_empty());
        // With the guard gone the pair stores, so `uninstall` really removed the
        // enforcement rather than hiding it.
        insert_session(&db, "unguarded", "plan", Some(CURSOR_PROVIDER_ID)).unwrap();
        install(&db).unwrap();
    }

    #[test]
    fn the_write_itself_refuses_the_pair_for_every_insert() {
        let (_dir, db) = test_db();
        for (index, mode) in ["plan", "goal"].into_iter().enumerate() {
            assert_eq!(
                insert_session(
                    &db,
                    &format!("guarded-{index}"),
                    mode,
                    Some(CURSOR_PROVIDER_ID)
                )
                .unwrap_err()
                .to_string(),
                PLAN_GOAL_CURSOR_UNSUPPORTED
            );
        }
        // Agent mode, other providers and a missing provider are untouched.
        insert_session(&db, "agent-cursor", "agent", Some(CURSOR_PROVIDER_ID)).unwrap();
        insert_session(&db, "plan-openai", "plan", Some("openai")).unwrap();
        insert_session(&db, "plan-none", "plan", None).unwrap();
        insert_session(&db, "plan-missing", "plan", Some("")).unwrap();
        // Near-misses are not the canonical provider.
        for (index, provider) in ["Cursor", "cursor ", "plugin:acme:cursor", "cursor-agent"]
            .into_iter()
            .enumerate()
        {
            insert_session(&db, &format!("near-miss-{index}"), "plan", Some(provider)).unwrap();
        }
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 8);
    }

    #[test]
    fn the_write_itself_refuses_a_transition_into_the_pair() {
        let (_dir, db) = test_db();
        insert_session(&db, "cursor-agent", "agent", Some(CURSOR_PROVIDER_ID)).unwrap();
        insert_session(&db, "plain-plan", "plan", Some("openai")).unwrap();

        // Entering a contract mode on a Cursor-bound row.
        let error = db
            .conn()
            .execute(
                "UPDATE sessions SET mode = 'goal' WHERE id = 'cursor-agent'",
                [],
            )
            .unwrap_err()
            .to_string();
        assert_eq!(error, PLAN_GOAL_CURSOR_UNSUPPORTED);

        // Binding Cursor while a contract mode is active.
        let error = db
            .conn()
            .execute(
                "UPDATE sessions SET provider_id = ?1, model_id = 'm' WHERE id = 'plain-plan'",
                params![CURSOR_PROVIDER_ID],
            )
            .unwrap_err()
            .to_string();
        assert_eq!(error, PLAN_GOAL_CURSOR_UNSUPPORTED);

        // The guarded columns are the only ones the trigger watches, and both
        // repairs pass.
        db.conn()
            .execute(
                "UPDATE sessions SET title = 'renamed' WHERE id = 'plain-plan'",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE sessions SET mode = 'agent' WHERE id = 'cursor-agent'",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE sessions SET provider_id = 'openai' WHERE id = 'plain-plan'",
                [],
            )
            .unwrap();
        let modes: Vec<String> = db
            .conn()
            .prepare("SELECT mode FROM sessions ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(modes, vec!["agent".to_string(), "plan".to_string()]);
    }

    #[test]
    fn a_legacy_row_keeps_working_and_can_be_repaired() {
        let (_dir, db) = test_db();
        plant_legacy_contract_cursor_session(&db, "legacy-plan-cursor").unwrap();

        // Unrelated writes on the legacy row are not the guard's business.
        db.conn()
            .execute(
                "UPDATE sessions SET title = 'Legacy renamed' WHERE id = 'legacy-plan-cursor'",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE sessions SET thinking_level = 'high' WHERE id = 'legacy-plan-cursor'",
                [],
            )
            .unwrap();

        // Rewriting both guarded columns to the values they already hold (a
        // model change, or the composer echoing its own state) stays allowed.
        db.conn()
            .execute(
                "UPDATE sessions SET mode = 'plan', provider_id = 'cursor', model_id = 'other' \
                 WHERE id = 'legacy-plan-cursor'",
                [],
            )
            .unwrap();

        // Hopping to the other contract mode is a transition into the pair,
        // not tolerated stale data.
        assert_eq!(
            db.conn()
                .execute(
                    "UPDATE sessions SET mode = 'goal' WHERE id = 'legacy-plan-cursor'",
                    [],
                )
                .unwrap_err()
                .to_string(),
            PLAN_GOAL_CURSOR_UNSUPPORTED
        );

        // The repair paths work: drop the mode, or choose another provider.
        db.conn()
            .execute(
                "UPDATE sessions SET mode = 'agent' WHERE id = 'legacy-plan-cursor'",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE sessions SET mode = 'plan', provider_id = 'openai' WHERE id = 'legacy-plan-cursor'",
                [],
            )
            .unwrap();
        let provider: Option<String> = db
            .conn()
            .query_row(
                "SELECT provider_id FROM sessions WHERE id = 'legacy-plan-cursor'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(provider.as_deref(), Some("openai"));
    }

    #[test]
    fn a_legacy_goal_row_cannot_hop_to_plan_either() {
        let (_dir, db) = test_db();
        plant_legacy_contract_cursor_session(&db, "legacy").unwrap();
        // Make it a legacy Goal row without tripping the guard: install the row
        // as plan, then repair to Goal + another provider, then re-bind Cursor.
        db.conn()
            .execute(
                "UPDATE sessions SET provider_id = 'openai' WHERE id = 'legacy'",
                [],
            )
            .unwrap();
        db.conn()
            .execute("UPDATE sessions SET mode = 'goal' WHERE id = 'legacy'", [])
            .unwrap();
        uninstall(&db).unwrap();
        db.conn()
            .execute(
                "UPDATE sessions SET provider_id = ?1 WHERE id = 'legacy'",
                params![CURSOR_PROVIDER_ID],
            )
            .unwrap();
        install(&db).unwrap();

        assert_eq!(
            db.conn()
                .execute("UPDATE sessions SET mode = 'plan' WHERE id = 'legacy'", [])
                .unwrap_err()
                .to_string(),
            PLAN_GOAL_CURSOR_UNSUPPORTED
        );
        db.conn()
            .execute("UPDATE sessions SET mode = 'agent' WHERE id = 'legacy'", [])
            .unwrap();
    }

    #[test]
    fn the_guard_is_what_refuses_the_write() {
        let (_dir, db) = test_db();
        uninstall(&db).unwrap();
        // Without the guard the pair is storable: the guard, not the SQL, is
        // the enforcement.
        insert_session(&db, "unguarded", "plan", Some(CURSOR_PROVIDER_ID)).unwrap();
        install(&db).unwrap();
        assert_eq!(
            insert_session(&db, "guarded-again", "plan", Some(CURSOR_PROVIDER_ID))
                .unwrap_err()
                .to_string(),
            PLAN_GOAL_CURSOR_UNSUPPORTED
        );
    }

    #[test]
    fn the_guard_text_uses_the_canonical_identifiers() {
        let sql = guard_sql();
        assert!(sql.contains(&format!("provider_id = '{CURSOR_PROVIDER_ID}'")));
        assert!(sql.contains(PLAN_GOAL_CURSOR_UNSUPPORTED));
        assert!(sql.contains("new.mode IN ('plan', 'goal')"));
        assert!(sql.contains("BEFORE UPDATE OF mode, provider_id"));
    }
}
