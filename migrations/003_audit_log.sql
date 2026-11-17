-- Activity log for admins: who did what, when, from where. No foreign keys on purpose: the history must outlive deleted accounts and tickets.
-- Message bodies, passwords and temporary passwords are never written here.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  actor_id   INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',          -- requester | agent | admin | system
  action     TEXT NOT NULL,                     -- e.g. ticket.created, signin.failed
  category   TEXT NOT NULL,                     -- ticket | message | signin | account | admin | security
  ticket_id  INTEGER,
  summary    TEXT NOT NULL,
  ip         TEXT,
  device     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_cat  ON audit_log(category, id DESC);
