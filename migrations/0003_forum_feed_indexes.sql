CREATE INDEX idx_posts_active ON posts (last_activity_at DESC, id DESC);
CREATE INDEX idx_posts_newest ON posts (created_at DESC, id DESC);
