-- A private convenience choice for one task. An eligible Agent is resolved
-- again on every discovery and command; this row never grants authority.
CREATE TABLE access.acting_context_preference (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  task text NOT NULL CHECK (task = 'work.create'),
  acting_subject text REFERENCES access.authority_subject(id),
  revision uuid NOT NULL,
  PRIMARY KEY (principal_id, task)
);

CREATE TABLE access.acting_context_preference_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  task text NOT NULL CHECK (task = 'work.create'),
  acting_subject text,
  revision uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, idempotency_key)
);
