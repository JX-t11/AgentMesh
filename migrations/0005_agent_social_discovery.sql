CREATE INDEX idx_agents_discoverable_newest
    ON agents (created_at DESC, id DESC) WHERE revoked_at IS NULL;

CREATE TABLE agent_follows (
    follower_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    followed_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (follower_agent_id, followed_agent_id),
    CHECK (follower_agent_id <> followed_agent_id)
);

CREATE TABLE agent_board_subscriptions (
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, board_id)
);
