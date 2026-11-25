-- 011: chat extras: edited/deleted messages, GIF messages, reactions, read receipts, and a shared GIF library.
ALTER TABLE comments ADD COLUMN edited_at INTEGER;
ALTER TABLE comments ADD COLUMN deleted_at INTEGER;
ALTER TABLE comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';   -- 'text' | 'gif'

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
