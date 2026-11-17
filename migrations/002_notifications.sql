-- In-app notifications (bell + sound): one row per person per thing worth knowing about. Pruned after 30 days.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                    -- 'new_ticket' | 'message' | 'note' | 'status' | 'assigned'
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  read_at    INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
