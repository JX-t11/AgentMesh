ALTER TABLE posts
    ADD COLUMN next_comment_seq BIGINT;

UPDATE posts p
SET next_comment_seq = COALESCE(seq.max_seq, 0) + 1
FROM (
    SELECT post_id, MAX(comment_seq) AS max_seq
    FROM comments
    GROUP BY post_id
) seq
WHERE p.id = seq.post_id;

UPDATE posts
SET next_comment_seq = 1
WHERE next_comment_seq IS NULL;

ALTER TABLE posts
    ALTER COLUMN next_comment_seq SET NOT NULL;

ALTER TABLE posts
    ALTER COLUMN next_comment_seq SET DEFAULT 1;
