-- Reference copy of the main dashboard/app queries (SQLite). The live versions are in src/server/*.ts.
-- Always use bound parameters (?) from the server, never string concatenation.
-- "open" below means status NOT IN ('resolved','closed').

-- 1. Priority board: open tickets, most urgent first, then oldest
SELECT t.id, t.ref, t.title, t.status, t.priority, t.due_at, t.created_at,
       u.name AS requester, a.name AS assignee, c.name AS category
FROM tickets t
JOIN users u ON u.id = t.requester_id
LEFT JOIN users a ON a.id = t.assignee_id
LEFT JOIN categories c ON c.id = t.category_id
WHERE t.status NOT IN ('resolved','closed')
ORDER BY t.priority_rank DESC, t.created_at ASC
LIMIT 50;

-- 2. Summary cards: count by priority (open only)
SELECT priority, COUNT(*) AS n
FROM tickets
WHERE status NOT IN ('resolved','closed')
GROUP BY priority;

-- 3. Count by status
SELECT status, COUNT(*) AS n FROM tickets GROUP BY status;

-- 4. Overdue (past SLA target)
SELECT id, ref, title, priority, due_at
FROM tickets
WHERE status NOT IN ('resolved','closed') AND due_at IS NOT NULL AND due_at < unixepoch()
ORDER BY due_at ASC;

-- 5. Unassigned open tickets
SELECT id, ref, title, priority, created_at
FROM tickets
WHERE assignee_id IS NULL AND status NOT IN ('resolved','closed')
ORDER BY priority_rank DESC, created_at ASC;

-- 6. Workload per agent
SELECT a.name, COUNT(*) AS open_tickets
FROM tickets t JOIN users a ON a.id = t.assignee_id
WHERE t.status NOT IN ('resolved','closed')
GROUP BY a.id
ORDER BY open_tickets DESC;

-- 7. Created vs resolved per day, last 30 days (trend chart)
SELECT date(created_at, 'unixepoch') AS day, COUNT(*) AS created
FROM tickets WHERE created_at >= unixepoch() - 30*86400
GROUP BY day ORDER BY day;

SELECT date(resolved_at, 'unixepoch') AS day, COUNT(*) AS resolved
FROM tickets WHERE resolved_at >= unixepoch() - 30*86400
GROUP BY day ORDER BY day;

-- 8. Avg first response and resolution time (hours), last 30 days
SELECT
  ROUND(AVG(first_response_at - created_at) / 3600.0, 1) AS avg_first_response_hrs,
  ROUND(AVG(resolved_at - created_at) / 3600.0, 1)       AS avg_resolution_hrs
FROM tickets
WHERE created_at >= unixepoch() - 30*86400;

-- 9. By category (manager view)
SELECT c.name, COUNT(*) AS n
FROM tickets t JOIN categories c ON c.id = t.category_id
WHERE t.created_at >= unixepoch() - 30*86400
GROUP BY c.id ORDER BY n DESC;

-- 10. By entity (which Fortress company raises most tickets)
SELECT COALESCE(u.entity,'Unspecified') AS entity, COUNT(*) AS n
FROM tickets t JOIN users u ON u.id = t.requester_id
WHERE t.created_at >= unixepoch() - 30*86400
GROUP BY entity ORDER BY n DESC;

-- 11. Requester view: my tickets
SELECT id, ref, title, status, priority, updated_at
FROM tickets WHERE requester_id = ? ORDER BY created_at DESC LIMIT 50;

-- 12. Ticket thread (hide internal notes from requesters in the app layer or add AND internal = 0)
SELECT c.id, c.body, c.internal, c.created_at, u.name AS author
FROM comments c JOIN users u ON u.id = c.author_id
WHERE c.ticket_id = ? ORDER BY c.created_at ASC;

-- 13. Pending notifications (the server's notifier loop picks these up, sends via SMTP/Graph, then marks notified)
SELECT e.id, e.ticket_id, e.field, e.old_value, e.new_value, t.ref, t.title, u.email AS requester_email
FROM ticket_events e
JOIN tickets t ON t.id = e.ticket_id
JOIN users u ON u.id = t.requester_id
WHERE e.notified = 0 AND e.field IN ('status','assignee')
ORDER BY e.created_at ASC LIMIT 25;

UPDATE ticket_events SET notified = 1 WHERE id = ?;

-- 14. Create-time helpers (app computes these):
--   priority_rank: urgent=4 high=3 medium=2 low=1
--   due_at: unixepoch() + SLA hours * 3600 (e.g. urgent 4h, high 8h, medium 24h, low 72h)
--   ref: after INSERT, UPDATE tickets SET ref = 'FG-' || printf('%04d', id) WHERE id = ?;
-- On status change set the matching timestamp:
UPDATE tickets
SET status = ?, updated_at = unixepoch(),
    resolved_at = CASE WHEN ? = 'resolved' THEN unixepoch() ELSE resolved_at END,
    closed_at   = CASE WHEN ? = 'closed'   THEN unixepoch() ELSE closed_at END
WHERE id = ?;
