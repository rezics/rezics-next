-- Vanity names are public aliases; the immutable graph identity remains the Agent IRI.
CREATE TABLE access.agent_handle (
  handle text PRIMARY KEY CHECK (handle ~ '^[a-z0-9_]{3,30}$'),
  agent_id text NOT NULL REFERENCES access.authority_subject(id),
  state text NOT NULL CHECK (state IN ('current', 'retired')),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_until timestamptz,
  CHECK ((state = 'retired') = (retired_until IS NOT NULL))
);
CREATE UNIQUE INDEX agent_handle_current_agent ON access.agent_handle(agent_id)
  WHERE state = 'current';
CREATE INDEX agent_handle_agent ON access.agent_handle(agent_id, state);
CREATE TABLE access.agent_handle_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  agent_id text NOT NULL,
  handle text NOT NULL,
  previous_handle text,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);
-- A principal has one first-sign-in person Agent, regardless of browser sessions.
CREATE INDEX agent_provision_first_person ON access.agent_provision(principal_id, created_at, id)
  WHERE agent_kind = 'person' AND state = 'active';

CREATE INDEX agent_provision_pending_person_onboarding
  ON access.agent_provision(principal_id, created_at, id)
  WHERE agent_kind = 'person' AND idempotency_key LIKE 'system:person-onboarding:%'
    AND state IN ('planned', 'graph_committed', 'compensating');
