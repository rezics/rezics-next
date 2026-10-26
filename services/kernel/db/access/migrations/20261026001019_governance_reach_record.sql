-- migrate:up
CREATE TABLE access.governance_reach (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  transaction_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('moderation:takedown', 'post:erase', 'media:erase', 'access:grant')),
  resource_id uuid NOT NULL,
  actor_account_id uuid NOT NULL,
  PRIMARY KEY (route, transaction_id, action, resource_id),
  CHECK (route = (get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11))
);

-- migrate:down
DROP TABLE access.governance_reach;
