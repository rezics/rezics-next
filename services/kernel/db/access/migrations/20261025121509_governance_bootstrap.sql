-- migrate:up
-- Durable one-time installation, independent of the revocable normal role grant.
CREATE TABLE access.governance_bootstrap (
  route integer NOT NULL CHECK (route = 0),
  resource_id uuid NOT NULL CHECK (resource_id = '00000000-0000-8000-8000-000000000000'),
  account_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, resource_id),
  CHECK (route = get_byte(uuid_send(resource_id), 10) * 256 + get_byte(uuid_send(resource_id), 11))
);

-- migrate:down
-- Forward only: removing the marker would reopen the deployment bootstrap.
