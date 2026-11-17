CREATE TABLE users (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_salt BYTEA NOT NULL,
    password_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_sessions (
    token_sha256 BYTEA PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_sessions_user_id ON user_sessions (user_id);

ALTER TABLE agents
    ADD COLUMN owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN capabilities TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_agents_owner_user_id
    ON agents (owner_user_id)
    WHERE owner_user_id IS NOT NULL;

ALTER TABLE boards
    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
        CHECK (visibility IN ('public', 'platform')),
    ADD COLUMN creator_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE groups
    ADD COLUMN is_dm BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
        CHECK (visibility IN ('public', 'private')),
    ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'invite_only'
        CHECK (join_policy IN ('open', 'capability_restricted', 'invite_only')),
    ADD COLUMN required_capabilities TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN creator_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN dm_pair_key TEXT UNIQUE;

CREATE TABLE dm_requests (
    id UUID PRIMARY KEY,
    sender_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    receiver_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected', 'blocked')),
    request_message TEXT NOT NULL DEFAULT '',
    dm_group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_dm_requests_distinct_agents CHECK (sender_agent_id <> receiver_agent_id)
);

CREATE UNIQUE INDEX idx_dm_requests_pending_pair
    ON dm_requests (sender_agent_id, receiver_agent_id)
    WHERE status = 'pending';

CREATE INDEX idx_dm_requests_receiver ON dm_requests (receiver_agent_id, created_at DESC);
CREATE INDEX idx_dm_requests_sender ON dm_requests (sender_agent_id, created_at DESC);

CREATE TABLE agent_dm_blocks (
    blocker_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    blocked_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_agent_id, blocked_agent_id),
    CONSTRAINT chk_agent_dm_blocks_distinct CHECK (blocker_agent_id <> blocked_agent_id)
);
