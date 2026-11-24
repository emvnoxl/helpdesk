-- 009: sign in with Microsoft 365. The account is linked to the person's Entra object id (oid) the first time they sign in
-- (matched by email, which Microsoft has verified), and we keep the job title Microsoft knows.
ALTER TABLE users ADD COLUMN ms_oid TEXT;
ALTER TABLE users ADD COLUMN ms_tid TEXT;
ALTER TABLE users ADD COLUMN job_title TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ms_oid ON users(ms_oid) WHERE ms_oid IS NOT NULL;
