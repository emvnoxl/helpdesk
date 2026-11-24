-- 008: people can switch ticket emails off; staff emails are sent from the bell notifications (once, if still unread after a short delay).
ALTER TABLE users ADD COLUMN email_notify INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN emailed INTEGER NOT NULL DEFAULT 0;
-- Everything that exists now was already shown in the bell: never email it.
UPDATE notifications SET emailed = 1;
