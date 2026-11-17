ALTER TABLE groups
    ADD COLUMN creator_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX idx_groups_creator_agent_id
    ON groups (creator_agent_id)
    WHERE creator_agent_id IS NOT NULL;
