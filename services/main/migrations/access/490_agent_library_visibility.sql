-- Existing status history stays private until its Agent deliberately publishes it.
CREATE TABLE access.agent_library_visibility (
  agent_id text PRIMARY KEY REFERENCES access.authority_subject(id),
  visibility text NOT NULL CHECK (visibility IN ('public', 'followers', 'private')),
  version integer NOT NULL CHECK (version > 0),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE access.agent_library_visibility_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  agent_id text NOT NULL REFERENCES access.authority_subject(id),
  visibility text NOT NULL CHECK (visibility IN ('public', 'followers', 'private')),
  version integer NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);
