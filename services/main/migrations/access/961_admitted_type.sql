-- Descriptive registry metadata grants no structural behavior or authority.
INSERT INTO access.scope_gate (id) VALUES ('type:admit') ON CONFLICT DO NOTHING;

CREATE TABLE access.admitted_type (
  type_iri text PRIMARY KEY CHECK (length(type_iri) BETWEEN 1 AND 2048),
  base text NOT NULL CHECK (base IN ('work', 'resource')),
  labels jsonb NOT NULL CHECK (jsonb_typeof(labels) = 'object'
    AND labels ?& ARRAY['en','zh-Hant','zh-Hans','ja','ko','de','fr','es']),
  presentation text NOT NULL CHECK (presentation IN ('book','recipe','prompt','skill','guide','game','media','default')),
  cover text NOT NULL CHECK (cover IN ('portrait','landscape','square','document')),
  creation text NOT NULL CHECK (creation IN ('administrator','contributor')),
  interest text CHECK (interest IN ('books','software','ai','recipes','media')),
  primary_action text NOT NULL CHECK (primary_action IN ('read','install','copy','watch','visit')),
  priority bigint NOT NULL CHECK (priority BETWEEN 0 AND 9007199254740991),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  admitted_by text NOT NULL REFERENCES access.authority_subject(id),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','retired'))
);

CREATE TABLE access.type_admission_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  PRIMARY KEY (principal_id, idempotency_key)
);
