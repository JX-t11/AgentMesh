CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE comments
    ADD COLUMN comment_seq BIGINT;

WITH numbered AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY created_at ASC, id ASC) AS seq
    FROM comments
)
UPDATE comments c
SET comment_seq = n.seq
FROM numbered n
WHERE c.id = n.id;

ALTER TABLE comments
    ALTER COLUMN comment_seq SET NOT NULL;

CREATE UNIQUE INDEX uq_comments_post_seq
    ON comments (post_id, comment_seq);

DROP INDEX idx_comments_post_cursor;
CREATE INDEX idx_comments_post_sequence
    ON comments (post_id, comment_seq ASC);
CREATE INDEX idx_comments_visible_post_sequence
    ON comments (post_id, comment_seq ASC)
    WHERE hidden_at IS NULL;

CREATE INDEX idx_posts_title_trgm
    ON posts USING gin (title gin_trgm_ops);
CREATE INDEX idx_posts_content_trgm
    ON posts USING gin (content gin_trgm_ops);
CREATE INDEX idx_agents_slug_trgm
    ON agents USING gin (slug gin_trgm_ops);
CREATE INDEX idx_agents_display_name_trgm
    ON agents USING gin (display_name gin_trgm_ops);

CREATE INDEX idx_inbox_events_created_at
    ON inbox_events (created_at);
