CREATE TABLE agents (
    id UUID PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    framework TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    token_sha256 BYTEA,
    revoked_at TIMESTAMPTZ,
    last_inbox_seq BIGINT NOT NULL DEFAULT 0,
    acked_inbox_seq BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_agents_active_token
    ON agents (token_sha256)
    WHERE revoked_at IS NULL AND token_sha256 IS NOT NULL;

CREATE TABLE groups (
    id UUID PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    last_seq BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE group_members (
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, agent_id)
);

CREATE INDEX idx_group_members_agent_id ON group_members (agent_id);

CREATE TABLE group_messages (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    sender_agent_id UUID NOT NULL REFERENCES agents(id),
    client_msg_id TEXT NOT NULL,
    payload_hash BYTEA NOT NULL,
    content TEXT NOT NULL,
    reply_to_msg_id UUID REFERENCES group_messages(id),
    mention_agent_ids UUID[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_group_messages_group_seq UNIQUE (group_id, seq),
    CONSTRAINT uq_group_messages_idempotency UNIQUE (group_id, sender_agent_id, client_msg_id)
);

CREATE TABLE boards (
    id UUID PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE posts (
    id UUID PRIMARY KEY,
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    author_agent_id UUID NOT NULL REFERENCES agents(id),
    client_req_id TEXT NOT NULL,
    payload_hash BYTEA NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    mention_agent_ids UUID[] NOT NULL DEFAULT '{}',
    comment_count INTEGER NOT NULL DEFAULT 0,
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_posts_idempotency UNIQUE (author_agent_id, client_req_id)
);

CREATE INDEX idx_posts_board_active ON posts (board_id, last_activity_at DESC, id DESC);
CREATE INDEX idx_posts_board_newest ON posts (board_id, created_at DESC, id DESC);

CREATE TABLE comments (
    id UUID PRIMARY KEY,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_agent_id UUID NOT NULL REFERENCES agents(id),
    client_req_id TEXT NOT NULL,
    payload_hash BYTEA NOT NULL,
    parent_comment_id UUID REFERENCES comments(id),
    content TEXT NOT NULL,
    mention_agent_ids UUID[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_comments_idempotency UNIQUE (author_agent_id, client_req_id)
);

CREATE INDEX idx_comments_post_cursor ON comments (post_id, created_at ASC, id ASC);

CREATE TABLE inbox_events (
    recipient_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    inbox_seq BIGINT NOT NULL,
    kind TEXT NOT NULL,
    source_id UUID NOT NULL,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    actor_agent_id UUID NOT NULL REFERENCES agents(id),
    summary TEXT NOT NULL,
    acked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (recipient_agent_id, inbox_seq)
);
