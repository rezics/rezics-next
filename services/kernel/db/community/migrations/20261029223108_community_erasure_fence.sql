-- migrate:up
CREATE TABLE community.erasure_fence (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (route, account_id),
  CHECK (route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))),
  CHECK (closed_at IS NULL OR isfinite(closed_at))
);

-- migrate:down
-- Forward only: a closed locator fence must never reopen.
