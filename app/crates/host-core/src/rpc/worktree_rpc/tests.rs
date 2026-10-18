use super::*;
use crate::rpc::handle_request;
use crate::session_worktrees::test_support::{git_cmd, init_repo};
use crate::session_worktrees::{lifecycle, registry};
use tokio::sync::mpsc;

async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    handle_request(state.clone(), method, params, mpsc::unbounded_channel().0).await
}
fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Arc<Mutex<AppState>>) {
    let dir = tempfile::tempdir().unwrap();
    let repo = init_repo(&dir.path().join("repo"));
    let mut state = AppState::open(&dir.path().join("data")).unwrap();
    state.handshook = true;
    (dir, repo, Arc::new(Mutex::new(state)))
}
async fn create(state: &Arc<Mutex<AppState>>, repo: &Path) -> String {
    call(
        state,
        "session.create",
        json!({"engine":"omp", "projectPath":repo, "isolated":true}),
    )
    .await
    .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}
async fn row(state: &Arc<Mutex<AppState>>, id: &str) -> registry::WorktreeRow {
    registry::for_owner(&state.lock().await.db, id, None)
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn isolated_binding_survives_restart_and_preserves_project_identity() {
    let (dir, repo, state) = fixture();
    std::fs::write(repo.join("dirty.txt"), "left behind").unwrap();
    let id = create(&state, &repo).await;
    let row = row(&state, &id).await;
    assert!(row.branch.starts_with("omp-desktop/"));
    assert!(!Path::new(&row.path).join("dirty.txt").exists());
    let detail = call(&state, "session.get", json!({"id":id})).await.unwrap();
    assert_eq!(
        detail["session"]["projectPath"],
        json!(repo.canonicalize().unwrap())
    );
    assert_eq!(detail["session"]["worktree"]["branch"], row.branch);
    let root = call(&state, "session.executionRoot", json!({"sessionId":id}))
        .await
        .unwrap();
    assert_eq!(root["path"], row.path);
    drop(state);
    let mut restored = AppState::open(&dir.path().join("data")).unwrap();
    restored.handshook = true;
    let restored = Arc::new(Mutex::new(restored));
    lifecycle::reconcile(restored.clone(), GitRunner::default()).await;
    assert_eq!(
        call(&restored, "session.executionRoot", json!({"sessionId":id}))
            .await
            .unwrap(),
        root
    );
    let err = call(
        &restored,
        "session.moveProject",
        json!({"sessionId":id,"projectPath":repo}),
    )
    .await
    .unwrap_err();
    assert_eq!(err.data.unwrap()["errorCode"], "WORKTREE_MOVE_UNSUPPORTED");
}

#[tokio::test]
async fn preview_is_read_only_and_stale_preview_refuses_before_commit() {
    let (_dir, repo, state) = fixture();
    let id = create(&state, &repo).await;
    let row = row(&state, &id).await;
    let path = Path::new(&row.path).join("new.txt");
    std::fs::write(&path, "first").unwrap();
    let preview = call(&state, "worktree.preview", json!({"sessionId":id}))
        .await
        .unwrap();
    assert!(!repo.join("new.txt").exists());
    assert_eq!(
        git_cmd(Path::new(&row.path), &["rev-parse", "HEAD"]),
        git_cmd(&repo, &["rev-parse", "HEAD"])
    );
    std::fs::write(&path, "second").unwrap();
    let err = call(
        &state,
        "worktree.merge",
        json!({"sessionId":id,"previewToken":preview["preview"]["previewToken"]}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        err.data.unwrap()["errorCode"],
        "WORKTREE_CHANGED_SINCE_PREVIEW"
    );
    assert!(!repo.join("new.txt").exists());
    let preview = call(&state, "worktree.preview", json!({"sessionId":id}))
        .await
        .unwrap();
    let outcome = call(
        &state,
        "worktree.merge",
        json!({"sessionId":id,"previewToken":preview["preview"]["previewToken"]}),
    )
    .await
    .unwrap();
    assert_eq!(outcome["outcome"]["result"], "merged");
    assert_eq!(
        std::fs::read_to_string(repo.join("new.txt")).unwrap(),
        "second"
    );
}

#[tokio::test]
async fn running_and_held_sessions_refuse_mutations_and_new_turns() {
    let (_dir, repo, state) = fixture();
    let id = create(&state, &repo).await;
    let started = call(&state, "session.beginTurn", json!({"sessionId":id}))
        .await
        .unwrap();
    for method in ["worktree.merge", "worktree.sync", "session.delete"] {
        let error = call(
            &state,
            method,
            json!({"sessionId":id,"id":id,"previewToken":"unused"}),
        )
        .await
        .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "WORKTREE_BUSY");
    }
    call(
        &state,
        "session.endTurn",
        json!({"turnId":started["turnId"],"status":"completed"}),
    )
    .await
    .unwrap();
    let budget = state.lock().await.tool_budget.clone();
    let held = budget
        .acquire_session_exclusive(&id, std::time::Duration::from_secs(1))
        .await
        .unwrap();
    let error = call(&state, "session.beginTurn", json!({"sessionId":id}))
        .await
        .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "WORKTREE_BUSY");
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(10),
        budget.acquire(&id, "Write")
    )
    .await
    .is_err());
    drop(held);
    assert!(call(&state, "session.beginTurn", json!({"sessionId":id}))
        .await
        .is_ok());
}

#[tokio::test]
async fn interrupted_creation_never_falls_back_to_project() {
    let (_dir, repo, state) = fixture();
    let id = create(&state, &repo).await;
    let row = row(&state, &id).await;
    registry::set_status(
        &state.lock().await.db,
        &row.id,
        registry::WorktreeStatus::Creating,
    )
    .unwrap();
    for method in ["session.delete", "worktree.preview"] {
        let error = call(&state, method, json!({"id":id,"sessionId":id}))
            .await
            .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "WORKTREE_NOT_READY");
    }
    lifecycle::reconcile(state.clone(), GitRunner::default()).await;
    let error = call(&state, "session.executionRoot", json!({"sessionId":id}))
        .await
        .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "WORKTREE_MISSING");
    assert!(repo.join("README.md").exists());
    assert_eq!(
        call(&state, "session.get", json!({"id":id})).await.unwrap()["session"]["worktree"]
            ["status"],
        "missing"
    );
}

#[tokio::test]
async fn failed_creation_rolls_back_session_and_non_omp_is_refused() {
    let (dir, repo, state) = fixture();
    let outside = dir.path().join("not-git");
    std::fs::create_dir(&outside).unwrap();
    let error = call(
        &state,
        "session.create",
        json!({"engine":"omp","isolated":true,"projectPath":outside}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "WORKTREE_NOT_GIT");
    assert_eq!(
        call(&state, "session.list", json!({})).await.unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert!(call(
        &state,
        "session.create",
        json!({"engine":"pi","isolated":true,"projectPath":repo})
    )
    .await
    .is_err());
}

#[test]
fn v21_upgrade_keeps_session_and_native_reference_and_makes_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = crate::db::Database::open(&path).unwrap();
    let session =
        sessions::create_session(&db, Some("kept".into()), None, None, None, None).unwrap();
    db.conn()
        .execute(
            "UPDATE sessions SET engine='omp' WHERE id=?1",
            rusqlite::params![session.id],
        )
        .unwrap();
    sessions::bind_session_engine_ref(
        &db,
        &session.id,
        Some(1),
        Some("18.3.0".into()),
        Some("native-kept".into()),
        Some("/fixture/native.jsonl".into()),
    )
    .unwrap();
    db.conn()
        .execute_batch("DROP TABLE worktrees; PRAGMA user_version=21;")
        .unwrap();
    drop(db);
    let db = crate::db::Database::open(&path).unwrap();
    assert_eq!(
        sessions::session_summary(&db, &session.id)
            .unwrap()
            .unwrap()
            .title,
        "kept"
    );
    assert_eq!(
        sessions::session_engine_ref(&db, &session.id)
            .unwrap()
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-kept")
    );
    assert!(registry::all(&db).unwrap().is_empty());
    assert!(std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().contains("v21")));
}
