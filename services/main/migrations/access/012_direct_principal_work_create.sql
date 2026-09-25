-- Direct account authority is independent of an Agent's represented grants.
-- A public Agent used for Work attribution needs its own explicit binding.
CREATE TABLE access.principal_permission_grant (
    id uuid PRIMARY KEY,
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    action text NOT NULL CHECK (action = 'work.create'),
    active boolean NOT NULL DEFAULT true,
    valid_until timestamptz NOT NULL,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE INDEX principal_permission_grant_active_lookup ON access.principal_permission_grant
    (principal_id, scope_id, action, valid_until) WHERE active;
CREATE INDEX principal_permission_grant_issuer_fk ON access.principal_permission_grant (issuer_subject);
CREATE INDEX principal_permission_grant_scope_fk ON access.principal_permission_grant (scope_id);

CREATE TABLE access.principal_agent_attribution (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    agent_subject text NOT NULL REFERENCES access.authority_subject(id),
    action text NOT NULL CHECK (action = 'work.create'),
    active boolean NOT NULL DEFAULT true,
    valid_until timestamptz NOT NULL,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE INDEX principal_agent_attribution_active_lookup ON access.principal_agent_attribution
    (principal_id, agent_subject, action, valid_until) WHERE active;
CREATE INDEX principal_agent_attribution_agent_fk ON access.principal_agent_attribution (agent_subject);

ALTER TABLE access.admission ADD COLUMN authority_path text NOT NULL DEFAULT 'represented-agent'
    CHECK (authority_path IN ('represented-agent', 'direct-principal'));
ALTER TABLE access.admission ADD COLUMN direct_grant_id uuid
    REFERENCES access.principal_permission_grant(id);
ALTER TABLE access.admission ADD COLUMN attribution_id uuid
    REFERENCES access.principal_agent_attribution(id);
ALTER TABLE access.admission ADD COLUMN direct_grant_generation bigint;
ALTER TABLE access.admission ADD COLUMN attribution_generation bigint;
ALTER TABLE access.admission ADD COLUMN direct_subject_generation bigint;
ALTER TABLE access.admission ADD COLUMN direct_principal_epoch bigint;
ALTER TABLE access.admission ADD CONSTRAINT direct_principal_admission_proof CHECK (
    (authority_path = 'represented-agent' AND direct_grant_id IS NULL AND attribution_id IS NULL
        AND direct_grant_generation IS NULL AND attribution_generation IS NULL
        AND direct_subject_generation IS NULL AND direct_principal_epoch IS NULL)
    OR (authority_path = 'direct-principal' AND action = 'work.create'
        AND scope_id = 'work:create:root' AND direct_grant_id IS NOT NULL
        AND attribution_id IS NOT NULL AND direct_grant_generation IS NOT NULL
        AND attribution_generation IS NOT NULL AND direct_subject_generation IS NOT NULL
        AND direct_principal_epoch IS NOT NULL)
);
