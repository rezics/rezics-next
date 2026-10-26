-- migrate:up
ALTER TABLE access.governance_reach
  DROP CONSTRAINT governance_reach_action_check,
  ADD CONSTRAINT governance_reach_action_check
    CHECK (action IN ('moderation:takedown', 'moderation:read_reports', 'post:erase', 'media:erase', 'access:grant'));

-- migrate:down
ALTER TABLE access.governance_reach
  DROP CONSTRAINT governance_reach_action_check,
  ADD CONSTRAINT governance_reach_action_check
    CHECK (action IN ('moderation:takedown', 'post:erase', 'media:erase', 'access:grant'));
