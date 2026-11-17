-- Normal users now have a personal PIN (separate from staff passwords). `session_version` is bumped to sign a person out on every computer
-- (PIN reset, PIN change, "sign out everywhere"); sessions issued before this migration count as version 1.
ALTER TABLE users ADD COLUMN pin_hash TEXT;
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;
