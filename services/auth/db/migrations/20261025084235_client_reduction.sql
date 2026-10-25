-- migrate:up
-- A reduction blocks new issuance while DBOS invalidates every existing owner.
CREATE TABLE auth_client_reduction (
  client_id text PRIMARY KEY REFERENCES auth_client (client_id),
  operation_id text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  first_party boolean NOT NULL
);

-- migrate:down
-- Forward only: an interrupted reduction must continue blocking issuance.
