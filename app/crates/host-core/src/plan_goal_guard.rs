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
//!   and any future caller — goes through the two triggers installed here.
//!   Refusing the *write itself* closes the window a pre-read leaves open: the
//!   condition is evaluated by SQLite against the row as it is written, so an
//!   update that races another writer cannot land on the refused pair.
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

/// Install the write guards. Idempotent, and run on every open so existing
/// databases gain them without a schema-version migration (the same pattern as
/// the boot-time `idx_turns_ended_at` index).
pub(crate) fn install(db: &Database) -> Result<()> {
    db.conn().execute_batch(&guard_sql())?;
    Ok(())
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
fn guard_sql() -> String {
    format!(
        r#"
CREATE TRIGGER IF NOT EXISTS sessions_refuse_cursor_contract_ai
  BEFORE INSERT ON sessions
  WHEN new.mode IN ('plan', 'goal') AND new.provider_id = '{provider}'
  BEGIN SELECT RAISE(ABORT, '{code}'); END;

CREATE TRIGGER IF NOT EXISTS sessions_refuse_cursor_contract_au
  BEFORE UPDATE OF mode, provider_id ON sessions
  WHEN new.mode IN ('plan', 'goal') AND new.provider_id = '{provider}'
   AND NOT (old.mode = new.mode AND old.provider_id = new.provider_id)
  BEGIN SELECT RAISE(ABORT, '{code}'); END;
"#,
        provider = CURSOR_PROVIDER_ID,
        code = PLAN_GOAL_CURSOR_UNSUPPORTED,
    )
}

/// Test-only: remove the guards so a fixture can plant the row an upgraded or
/// hand-edited database may already hold. Re-install with [`install`].
#[cfg(test)]
pub(crate) fn uninstall(db: &Database) -> Result<()> {
    db.conn().execute_batch(
        "DROP TRIGGER IF EXISTS sessions_refuse_cursor_contract_ai;
         DROP TRIGGER IF EXISTS sessions_refuse_cursor_contract_au;",
    )?;
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
    use crate::db::now_ms;
    use rusqlite::params;

    fn test_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn insert_session(db: &Database, id: &str, mode: &str, provider: Option<&str>) -> Result<usize> {
        Ok(db.conn().execute(
            "INSERT INTO sessions (
                id, title, provider_id, model_id, mode, thinking_level, permission_mode,
                engine, created_at, updated_at
             ) VALUES (?1, 'Guarded', ?2, 'm', ?3, 'off', 'inherit', 'pi', ?4, ?4)",
            params![id, provider, mode, now_ms()],
        )?)
    }

    #[test]
    fn the_write_itself_refuses_the_pair_for_every_insert() {
        let (_dir, db) = test_db();
        for (index, mode) in ["plan", "goal"].into_iter().enumerate() {
            assert_eq!(
                insert_session(&db, &format!("guarded-{index}"), mode, Some(CURSOR_PROVIDER_ID))
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
            .execute("UPDATE sessions SET title = 'renamed' WHERE id = 'plain-plan'", [])
            .unwrap();
        db.conn()
            .execute("UPDATE sessions SET mode = 'agent' WHERE id = 'cursor-agent'", [])
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
            .execute("UPDATE sessions SET provider_id = 'openai' WHERE id = 'legacy'", [])
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
