-- Session selection is keyed by an opaque client session UUID and an Account
-- principal. The account-wide main Agent is a separate, optional preference.
-- Neither table grants authority; reads and writes recheck current eligibility.
CREATE TABLE access.session_agent (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  session_key uuid NOT NULL,
  acting_subject text REFERENCES access.authority_subject(id),
  revision uuid NOT NULL,
  PRIMARY KEY (principal_id, session_key)
);

CREATE TABLE access.session_agent_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  session_key uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  acting_subject text,
  revision uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id, session_key, idempotency_key)
);

CREATE TABLE access.main_agent_preference (
  principal_id uuid PRIMARY KEY REFERENCES access.principal(id) ON DELETE CASCADE,
  acting_subject text REFERENCES access.authority_subject(id),
  revision uuid NOT NULL
);

CREATE TABLE access.main_agent_preference_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  acting_subject text,
  revision uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id, idempotency_key)
);
