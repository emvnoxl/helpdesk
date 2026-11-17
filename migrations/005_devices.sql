-- Computers people use. One row per person per browser (the browser keeps a random id), filled from two sources:
--   browser:  what the browser reports on its own (OS, CPU threads, approximate RAM, screen, graphics chip...)
--   hardware: the full report from the optional PowerShell script (make, model, serial, CPU name, RAM, disks, network...)
-- Tickets remember which computer they were raised from, so IT sees the machine inside the ticket.
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
ALTER TABLE tickets ADD COLUMN device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL;
