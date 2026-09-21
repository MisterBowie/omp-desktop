CREATE TABLE IF NOT EXISTS session_collaboration_links (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  created_by_session_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_collaboration_creator
  ON session_collaboration_links(created_by_session_id);

CREATE TABLE IF NOT EXISTS session_collaboration_messages (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_title TEXT NOT NULL,
  target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('task', 'message', 'completion')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  notify_on_completion INTEGER NOT NULL DEFAULT 0,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  reply_to_message_id TEXT,
  idempotency_key TEXT NOT NULL,
  remaining_hops INTEGER NOT NULL,
  permission_ceiling TEXT NOT NULL CHECK(permission_ceiling IN ('ask', 'accept-edits', 'auto')),
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(plugin_id, source_session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_session_collaboration_target
  ON session_collaboration_messages(target_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_collaboration_source
  ON session_collaboration_messages(source_session_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_collaboration_turn
  ON session_collaboration_messages(turn_id) WHERE turn_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_collaboration_receipt
  ON session_collaboration_messages(reply_to_message_id) WHERE kind = 'completion';
