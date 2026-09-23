-- Access-owned private state for the first one-scope command admission.
-- Account identity is referenced only after its assertion is verified by Main.
CREATE SCHEMA access;

CREATE TABLE access.principal (
    id uuid PRIMARY KEY,
    account_issuer text NOT NULL CHECK (account_issuer <> ''),
    account_subject text NOT NULL CHECK (account_subject <> ''),
    active boolean NOT NULL DEFAULT true,
    enforcement_epoch bigint NOT NULL DEFAULT 0 CHECK (enforcement_epoch >= 0),
    UNIQUE (account_issuer, account_subject)
);

CREATE TABLE access.authority_subject (
    id text PRIMARY KEY CHECK (id LIKE 'https://rezics.com/id/%'),
    kind text NOT NULL CHECK (kind IN ('agent', 'institution')),
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);

CREATE TABLE access.scope_gate (
    id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
    authority_epoch bigint NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
    open boolean NOT NULL DEFAULT true
);

CREATE TABLE access.representation (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    subject_id text NOT NULL REFERENCES access.authority_subject(id),
    action text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
    active boolean NOT NULL DEFAULT true,
    valid_until timestamptz NOT NULL,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE INDEX representation_active_lookup ON access.representation
    (principal_id, subject_id, action, valid_until) WHERE active;
CREATE INDEX representation_subject_fk ON access.representation (subject_id);

CREATE TABLE access.permission_grant (
    id uuid PRIMARY KEY,
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    recipient_subject text NOT NULL REFERENCES access.authority_subject(id),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    action text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
    active boolean NOT NULL DEFAULT true,
    valid_until timestamptz NOT NULL,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE INDEX permission_grant_active_lookup ON access.permission_grant
    (recipient_subject, scope_id, action, valid_until) WHERE active;
CREATE INDEX permission_grant_scope_fk ON access.permission_grant (scope_id);
CREATE INDEX permission_grant_issuer_fk ON access.permission_grant (issuer_subject);

CREATE TABLE access.admission (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    acting_subject text NOT NULL REFERENCES access.authority_subject(id),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    action text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
    expires_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('registered', 'sealed', 'cancelled')),
    registered_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (principal_id, action, idempotency_key)
);
CREATE INDEX admission_scope_open_lookup ON access.admission
    (scope_id, state, expires_at) WHERE state = 'registered';
CREATE INDEX admission_acting_subject_fk ON access.admission (acting_subject);

CREATE TABLE access.admission_receipt (
    admission_id uuid PRIMARY KEY REFERENCES access.admission(id),
    principal_id uuid NOT NULL,
    action text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    outcome text NOT NULL CHECK (outcome = 'registered'),
    committed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (principal_id, action, idempotency_key)
);

CREATE TABLE access.outbox (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('admission.registered', 'scope.closed')),
    admission_id uuid REFERENCES access.admission(id),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_outbox_order ON access.outbox (created_at, id);
CREATE INDEX access_outbox_admission_fk ON access.outbox (admission_id);
CREATE INDEX access_outbox_scope_fk ON access.outbox (scope_id);
