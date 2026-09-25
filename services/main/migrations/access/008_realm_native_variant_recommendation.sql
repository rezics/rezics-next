-- A Realm manager's optional reading hint. This is neither a publication nor an adoption.
CREATE TABLE access.realm_native_variant_recommendation (
  realm text NOT NULL CHECK (realm ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  main_version text NOT NULL CHECK (main_version ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  contribution text NOT NULL CHECK (contribution ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  revision uuid NOT NULL,
  acting_subject text NOT NULL REFERENCES access.authority_subject(id),
  PRIMARY KEY (realm, main_version)
);

CREATE TABLE access.realm_native_variant_recommendation_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  realm text NOT NULL,
  main_version text NOT NULL,
  contribution text,
  revision uuid,
  CONSTRAINT complete_realm_variant_receipt CHECK ((contribution IS NULL) = (revision IS NULL)),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, idempotency_key)
);
