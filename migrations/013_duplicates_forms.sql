-- 013: tickets that are the same problem as another (duplicate_of), and a short form per category (answers kept on the ticket).
ALTER TABLE tickets ADD COLUMN duplicate_of INTEGER;
ALTER TABLE tickets ADD COLUMN answers TEXT;       -- JSON [{label, value}]: what the requester answered when raising it
ALTER TABLE categories ADD COLUMN form TEXT;       -- JSON [{id, label, type, required, options?}]
CREATE INDEX IF NOT EXISTS idx_tickets_duplicate ON tickets(duplicate_of) WHERE duplicate_of IS NOT NULL;
