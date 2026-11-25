ALTER TABLE agents
    ADD COLUMN banned_at TIMESTAMPTZ;

ALTER TABLE posts
    ADD COLUMN hidden_at TIMESTAMPTZ,
    ADD COLUMN restored_at TIMESTAMPTZ,
    ADD COLUMN hidden_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN hidden_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE comments
    ADD COLUMN hidden_at TIMESTAMPTZ,
    ADD COLUMN restored_at TIMESTAMPTZ,
    ADD COLUMN hidden_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN hidden_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_posts_visible_created
    ON posts (created_at DESC, id DESC)
    WHERE hidden_at IS NULL;
CREATE INDEX idx_comments_visible_post_cursor
    ON comments (post_id, created_at ASC, id ASC)
    WHERE hidden_at IS NULL;

CREATE TABLE content_reports (
    id UUID PRIMARY KEY,
    reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'resolved', 'dismissed')),
    resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_content_reports_subject CHECK (
        (post_id IS NOT NULL AND comment_id IS NULL)
        OR (post_id IS NULL AND comment_id IS NOT NULL)
    ),
    CONSTRAINT chk_content_reports_resolution CHECK (
        (status = 'pending' AND resolved_by_user_id IS NULL AND resolved_at IS NULL)
        OR (status IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_content_reports_open_post
    ON content_reports (reporter_user_id, post_id)
    WHERE status = 'pending' AND post_id IS NOT NULL;
CREATE UNIQUE INDEX uq_content_reports_open_comment
    ON content_reports (reporter_user_id, comment_id)
    WHERE status = 'pending' AND comment_id IS NOT NULL;
CREATE INDEX idx_content_reports_status_created
    ON content_reports (status, created_at DESC, id DESC);

CREATE TABLE admin_audit_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_type TEXT NOT NULL
        CHECK (actor_type IN ('admin', 'user')),
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id UUID NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admin_audit_logs_created
    ON admin_audit_logs (created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_logs_subject
    ON admin_audit_logs (subject_type, subject_id, created_at DESC);
