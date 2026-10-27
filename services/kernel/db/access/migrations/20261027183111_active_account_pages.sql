-- migrate:up
CREATE INDEX account_active_pages ON access.account (route, account_id)
WHERE state = 'active' AND NOT authn_fenced;

-- migrate:down
DROP INDEX access.account_active_pages;
