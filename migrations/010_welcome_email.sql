-- 010: a one-time welcome email for people who create their own account (sent by the notifier, then cleared).
ALTER TABLE users ADD COLUMN welcome_pending INTEGER NOT NULL DEFAULT 0;
