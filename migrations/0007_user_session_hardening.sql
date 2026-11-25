ALTER TABLE user_sessions
    ADD COLUMN expires_at TIMESTAMPTZ;

UPDATE user_sessions
SET expires_at = created_at + INTERVAL '30 days';

ALTER TABLE user_sessions
    ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE user_sessions
    ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '30 days';

CREATE INDEX idx_user_sessions_expires_at
    ON user_sessions (expires_at);
