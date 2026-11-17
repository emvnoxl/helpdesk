-- 006: attachments, knowledge base, saved replies, response-target settings (+ pausing) and requester feedback.
-- schema.sql mirrors this for fresh installs.

-- Files on tickets. The bytes live in <DATA_DIR>/uploads/<stored>; this table is what says who may fetch them.
--   scope 'draft'   = uploaded in the composer, not sent yet (pruned after a couple of hours)
--   scope 'ticket'  = belongs to the ticket's description
--   scope 'comment' = belongs to message comment_id (hidden from requesters when that message is an internal note)
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id  INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'draft' CHECK (scope IN ('draft','ticket','comment')),
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  stored      TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_attachments_ticket  ON attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id) WHERE comment_id IS NOT NULL;

-- Response targets: the clock stops while a ticket is 'waiting' (on the requester), and an alert is sent once when a ticket is
-- close to its target (sla_alert = 1) and once when it is past it (2).
ALTER TABLE tickets ADD COLUMN paused_at   INTEGER;
ALTER TABLE tickets ADD COLUMN paused_secs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN sla_alert   INTEGER NOT NULL DEFAULT 0;
-- Tickets that are already late must not fire a flood of "breached" alerts the moment this version starts.
UPDATE tickets SET sla_alert = 2 WHERE status NOT IN ('resolved','closed') AND due_at IS NOT NULL AND due_at < unixepoch();

-- Requester feedback once a ticket is resolved: 1 = fixed, -1 = not fixed.
ALTER TABLE tickets ADD COLUMN rating         INTEGER;
ALTER TABLE tickets ADD COLUMN rating_comment TEXT;
ALTER TABLE tickets ADD COLUMN rated_at       INTEGER;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Help articles. Normal users see the published ones (browse + suggestions while they write a ticket); staff write them.
CREATE TABLE IF NOT EXISTS kb_articles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  published   INTEGER NOT NULL DEFAULT 1,
  views       INTEGER NOT NULL DEFAULT 0,
  helpful     INTEGER NOT NULL DEFAULT 0,
  not_helpful INTEGER NOT NULL DEFAULT 0,
  author_id   INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS kb_votes (
  article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL,
  helpful    INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (article_id, user_id)
);

-- Saved replies for the staff composer. owner_id NULL = shared by the whole team (admins manage those).
CREATE TABLE IF NOT EXISTS canned_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_replies_owner ON canned_replies(owner_id);
