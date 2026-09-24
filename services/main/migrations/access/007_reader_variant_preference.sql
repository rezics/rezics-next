-- Sparse private reader choice. Publication eligibility remains graph-owned.
CREATE TABLE access.reader_variant_preference (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  main_version text NOT NULL CHECK (main_version ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  contribution text NOT NULL CHECK (contribution ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  revision uuid NOT NULL,
  PRIMARY KEY (principal_id, main_version)
);

CREATE TABLE access.reader_variant_preference_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  main_version text NOT NULL,
  contribution text,
  revision uuid,
  CONSTRAINT complete_reader_variant_receipt CHECK ((contribution IS NULL) = (revision IS NULL)),
  replayed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, idempotency_key)
);
