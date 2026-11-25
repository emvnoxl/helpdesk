-- Fortress helpdesk: SQLite schema (fresh installs).
-- Applied automatically on first start (see src/server/db.ts). Later changes go in migrations/NNN_name.sql,
-- applied in order and tracked with PRAGMA user_version. The current version is SCHEMA_VERSION in db.ts.
-- Timestamps are unix seconds (INTEGER) so date maths is cheap and index-friendly.

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'requester'
              CHECK (role IN ('requester','agent','admin')),
  entity      TEXT,                            -- e.g. 'Oil & Gas Solutions', 'Asset Integrity Solutions'
  department  TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  -- Staff (agent / admin) sign in with a password. Requesters have none: they identify with name + company email.
  password_hash        TEXT,                   -- scrypt:N:r:p:salt:hash
  must_change_password INTEGER NOT NULL DEFAULT 0,   -- 1 = temporary password, must be replaced at next sign-in
  credential_version   INTEGER NOT NULL DEFAULT 1,   -- bumped on password change/reset/disable: ends every staff session
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         INTEGER NOT NULL DEFAULT 0,
  last_login_at        INTEGER,
  -- Normal users have a personal PIN (hashed like a password); session_version ends all their sessions when bumped.
  pin_hash             TEXT,
  session_version      INTEGER NOT NULL DEFAULT 1,
  email_notify         INTEGER NOT NULL DEFAULT 1,   -- 0 = this person asked for no ticket emails
  welcome_pending      INTEGER NOT NULL DEFAULT 0,   -- 1 = a one-time welcome email is waiting to be sent
  ms_oid               TEXT,                         -- Microsoft 365 (Entra) object id, linked at the first Microsoft sign-in
  ms_tid               TEXT,
  job_title            TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ms_oid ON users(ms_oid) WHERE ms_oid IS NOT NULL;

CREATE TABLE IF NOT EXISTS categories (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,                  -- Network, Hardware, M365, Access/Accounts, Printing, AV, CCTV, Other
  form  TEXT                                   -- JSON [{id, label, type, required, options?}]: the questions asked for this category
);

CREATE TABLE IF NOT EXISTS tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT UNIQUE,                   -- human id like FG-0042, set by the app after insert
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','in_progress','waiting','resolved','closed')),
  priority      TEXT NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('low','medium','high','urgent')),
  priority_rank INTEGER NOT NULL DEFAULT 2,    -- urgent=4 high=3 medium=2 low=1; makes ORDER BY simple
  priority_locked INTEGER NOT NULL DEFAULT 0,  -- 1 = set by an admin; agents can't change it
  category_id   INTEGER REFERENCES categories(id),
  requester_id  INTEGER NOT NULL REFERENCES users(id),
  assignee_id   INTEGER REFERENCES users(id),
  asset_tag     TEXT,                          -- optional link to an asset register
  due_at        INTEGER,                       -- SLA target, set from priority on create
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  first_response_at INTEGER,
  resolved_at   INTEGER,
  closed_at     INTEGER,
  device_id     INTEGER REFERENCES devices(id) ON DELETE SET NULL,  -- the computer it was raised from
  paused_at     INTEGER,                       -- set while status = 'waiting': the response-target clock is stopped
  paused_secs   INTEGER NOT NULL DEFAULT 0,    -- total time spent waiting (added to due_at when work resumes)
  sla_alert     INTEGER NOT NULL DEFAULT 0,    -- 0 none, 1 "close to target" sent, 2 "past target" sent
  rating        INTEGER,                       -- requester feedback: 1 fixed, -1 not fixed
  rating_comment TEXT,
  rated_at      INTEGER,
  source        TEXT NOT NULL DEFAULT 'web',   -- web | email | checklist | recurring
  duplicate_of  INTEGER,                       -- the main ticket this one is the same problem as
  answers       TEXT                           -- JSON [{label, value}]: the category form's answers
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  internal    INTEGER NOT NULL DEFAULT 0,      -- 1 = agent-only note, hidden from the requester
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  edited_at   INTEGER,
  deleted_at  INTEGER,
  kind        TEXT NOT NULL DEFAULT 'text',    -- 'text' | 'gif' (a library GIF, as an attachment) | 'giphy' (gif_ref = the GIPHY id)
  gif_ref     TEXT
);

-- Audit trail: status/priority/assignee changes. Powers "requester gets status updates".
CREATE TABLE IF NOT EXISTS ticket_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id),
  field       TEXT NOT NULL,                   -- 'status' | 'priority' | 'assignee' | 'created'
  old_value   TEXT,
  new_value   TEXT,
  notified    INTEGER NOT NULL DEFAULT 0,      -- 0 = notification still to send
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_role              ON users(role, active);
CREATE INDEX IF NOT EXISTS idx_tickets_status_priority ON tickets(status, priority_rank DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee_status ON tickets(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_requester       ON tickets(requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_due             ON tickets(due_at) WHERE status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS idx_tickets_created         ON tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_resolved        ON tickets(resolved_at);
CREATE INDEX IF NOT EXISTS idx_comments_ticket         ON comments(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_pending          ON ticket_events(notified, created_at) WHERE notified = 0;

INSERT OR IGNORE INTO categories (name) VALUES
  ('Network'),('Hardware'),('Microsoft 365'),('Accounts & Access'),
  ('Printing'),('AV / Production'),('CCTV / Security'),('Software'),('Other');

-- In-app notifications (bell + sound): one row per person per thing worth knowing about. Pruned after 30 days.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                    -- 'new_ticket' | 'message' | 'note' | 'status' | 'assigned'
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  read_at    INTEGER,
  emailed    INTEGER NOT NULL DEFAULT 0,       -- staff: 1 = already emailed (or not to be)
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);

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

-- Computers people use (see migrations/005_devices.sql).
CREATE TABLE IF NOT EXISTS devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_key  TEXT NOT NULL,
  first_seen  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_ip     TEXT,
  browser     TEXT,
  hardware    TEXT,
  hardware_at INTEGER,
  UNIQUE (user_id, device_key)
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id, last_seen DESC);

-- ---- 006: attachments, knowledge base, saved replies, settings (the new tickets columns are in the table above) ----
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

-- ---- 007: tickets by email, checklists (steps on a ticket + templates) and recurring tickets.


-- Every email taken in, by Message-ID, so the same message is never processed twice.
CREATE TABLE IF NOT EXISTS inbound_mail (
  message_id TEXT PRIMARY KEY,
  sender     TEXT NOT NULL,
  outcome    TEXT NOT NULL DEFAULT 'pending',   -- created | replied | ignored:<why>
  ticket_id  INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Reusable lists of steps (new starter, leaver...). items = JSON array of strings.
CREATE TABLE IF NOT EXISTS checklist_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  items       TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The steps on one ticket. Staff only; requesters never see them.
CREATE TABLE IF NOT EXISTS ticket_tasks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,
  text      TEXT NOT NULL,
  done      INTEGER NOT NULL DEFAULT 0,
  done_by   INTEGER,
  done_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_ticket ON ticket_tasks(ticket_id, position, id);

-- Jobs that come round again (backup check, licence renewal, UPS test): the scheduler raises a ticket when next_at passes.
CREATE TABLE IF NOT EXISTS recurring_tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  category_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  priority       TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  assignee_id    INTEGER,
  checklist_id   INTEGER REFERENCES checklist_templates(id) ON DELETE SET NULL,
  every          TEXT NOT NULL CHECK (every IN ('daily','weekdays','weekly','monthly','quarterly','yearly')),
  anchor_day     INTEGER NOT NULL DEFAULT 1,     -- day of the month it was first scheduled for (so the 31st doesn't drift to the 28th)
  next_at        INTEGER NOT NULL,
  last_run_at    INTEGER,
  last_ticket_id INTEGER,
  active         INTEGER NOT NULL DEFAULT 1,
  created_by     INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_tickets(next_at) WHERE active = 1;

-- Chat extras (migration 011)
CREATE TABLE IF NOT EXISTS comment_reactions (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (comment_id, user_id, emoji)
);

-- The newest message each person has had on screen, per ticket (read receipts).
CREATE TABLE IF NOT EXISTS ticket_reads (
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_comment_id INTEGER NOT NULL DEFAULT 0,
  seen_at         INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, user_id)
);

-- GIFs the company chose, shared by everyone in the picker (the files sit in the uploads folder).
CREATE TABLE IF NOT EXISTS gif_library (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  stored     TEXT NOT NULL UNIQUE,
  size       INTEGER NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
