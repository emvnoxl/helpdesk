-- 007: tickets by email, checklists (steps on a ticket + templates) and recurring tickets.
-- schema.sql mirrors this for fresh installs.

-- Where a ticket came from: 'web' (the form), 'email', 'checklist' (started from a template) or 'recurring' (the scheduler).
ALTER TABLE tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'web';

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
