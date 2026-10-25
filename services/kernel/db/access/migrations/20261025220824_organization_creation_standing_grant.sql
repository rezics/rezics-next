-- migrate:up
-- Independent one-time setups can install different standing actions on Global.
-- Each exact action set keeps its own permanent marker after ordinary revocation.
ALTER TABLE access.standing_parent_installation DROP CONSTRAINT standing_parent_installation_pkey;
ALTER TABLE access.standing_parent_installation ADD PRIMARY KEY (route, resource_id, actions);

-- migrate:down
-- Forward only: collapsing markers would reopen previously completed setups.
