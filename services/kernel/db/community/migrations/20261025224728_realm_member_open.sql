-- migrate:up
CREATE UNIQUE INDEX realm_member_open ON community.realm_member
  (route, realm_id, account_id) WHERE upper_inf(valid);

-- migrate:down
DROP INDEX community.realm_member_open;
