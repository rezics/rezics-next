-- migrate:up
CREATE TABLE content.account_erasure_progress (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  step bigint NOT NULL DEFAULT 0 CHECK (step >= 0),
  phase text NOT NULL CHECK (phase IN ('authored','uploads','reactions','moderation','proof','complete')),
  cursor jsonb,
  erased_at timestamptz NOT NULL,
  content_found boolean NOT NULL DEFAULT false,
  delivery_found boolean NOT NULL DEFAULT false,
  phase_pending boolean NOT NULL DEFAULT false,
  statements_kept_until timestamptz,
  PRIMARY KEY (route, account_id),
  CHECK (route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))),
  CHECK (isfinite(erased_at)),
  CHECK (statements_kept_until IS NULL OR isfinite(statements_kept_until))
);

-- Late decision effects cannot restore a party locator after the fence closes.
-- Keep only the retained statement's opaque owner key and expiry for its purge.
CREATE TABLE content.account_erasure_statement (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  owner_route integer NOT NULL,
  decision_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, due_at, decision_id),
  CHECK (route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))),
  CHECK (owner_route = ((get_byte(uuid_send(decision_id), 10) * 256) + get_byte(uuid_send(decision_id), 11))),
  CHECK (isfinite(due_at)),
  CHECK (owner_route BETWEEN 0 AND 65535),
  CHECK (route BETWEEN 0 AND 65535)
);

-- migrate:down
-- Forward only: participant progress and complaint statements cannot be restored.
