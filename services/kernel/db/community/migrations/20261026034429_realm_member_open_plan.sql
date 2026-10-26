-- migrate:up

-- Keep same-key history visible to the planner when comparing the partial
-- current-membership index with indexes that include every interval.
CREATE STATISTICS community.realm_member_key_mcv (mcv)
  ON route, realm_id, account_id FROM community.realm_member;

-- migrate:down
-- Forward only: membership history must remain durable.
