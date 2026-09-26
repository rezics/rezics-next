-- Agent-to-Agent representation composes a principal mandate into a bounded
-- path (P -> A -> B acts as B). One scope gate row serializes every edge write
-- so concurrent changes cannot each pass an isolated cycle check; its authority
-- epoch is the topology CAS token. Administration grants, memberships and
-- descriptive graph links are never edges.
INSERT INTO access.scope_gate (id) VALUES ('access:representation-topology');

-- Composite identities let proof rows prove, not merely assume, that every
-- selected piece belongs to the same principal, acting subject and operation.
ALTER TABLE access.representation
    ADD COLUMN max_path_edges smallint NOT NULL DEFAULT 0
        CHECK (max_path_edges BETWEEN 0 AND 8),
    ADD CONSTRAINT representation_path_identity UNIQUE (id, principal_id, subject_id, action);
ALTER TABLE access.permission_grant
    ADD CONSTRAINT permission_grant_holder UNIQUE (id, recipient_subject, scope_id, action),
    ADD CONSTRAINT permission_grant_identity
        UNIQUE (id, issuer_subject, recipient_subject, scope_id, action);
ALTER TABLE access.group_member
    ADD CONSTRAINT group_member_agent_identity UNIQUE (id, agent_subject);
ALTER TABLE access.group_permission_grant
    ADD CONSTRAINT group_permission_grant_identity UNIQUE (id, scope_id, action);
ALTER TABLE access.role_binding
    ADD CONSTRAINT role_binding_recipient_identity
        UNIQUE (id, recipient_subject, family_id, role_revision);

CREATE FUNCTION access.reject_authority_control_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable Access authority control record' USING ERRCODE = '23514';
END $$;

-- An existing mandate keeps limit 0 and therefore stays single-hop.
CREATE FUNCTION access.keep_representation_path_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.max_path_edges <> OLD.max_path_edges THEN
        RAISE EXCEPTION 'representation path limit is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representation_path_limit_immutable BEFORE UPDATE OF max_path_edges
    ON access.representation FOR EACH ROW
    EXECUTE FUNCTION access.keep_representation_path_limit();

-- representative -> represented: the representative may act as the represented
-- subject for one action. The represented subject issues it through a current
-- mandate and assignment ceiling, both pinned here.
CREATE TABLE access.representation_edge (
    id uuid PRIMARY KEY,
    representative_subject text NOT NULL REFERENCES access.authority_subject(id),
    represented_subject text NOT NULL REFERENCES access.authority_subject(id),
    action text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
    resource_subject text REFERENCES access.authority_subject(id),
    max_path_edges smallint NOT NULL CHECK (max_path_edges BETWEEN 1 AND 8),
    valid_until timestamptz NOT NULL,
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    assigned_by_principal uuid NOT NULL,
    issuer_representation_id uuid NOT NULL,
    issuer_representation_generation bigint NOT NULL
        CHECK (issuer_representation_generation >= 0),
    issuer_representation_action text NOT NULL,
    ceiling_grant_id uuid NOT NULL,
    ceiling_grant_generation bigint NOT NULL CHECK (ceiling_grant_generation >= 0),
    ceiling_scope_id text NOT NULL,
    ceiling_action text NOT NULL
        CHECK (ceiling_action LIKE 'access.representation.assign.%'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, representative_subject, represented_subject, action),
    CHECK (representative_subject <> represented_subject),
    CHECK (valid_until > created_at),
    FOREIGN KEY (issuer_representation_id, assigned_by_principal, represented_subject,
            issuer_representation_action)
        REFERENCES access.representation(id, principal_id, subject_id, action),
    FOREIGN KEY (ceiling_grant_id, represented_subject, ceiling_scope_id, ceiling_action)
        REFERENCES access.permission_grant(id, recipient_subject, scope_id, action)
);
CREATE INDEX representation_edge_forward ON access.representation_edge
    (representative_subject, action, valid_until, id) WHERE active;
CREATE INDEX representation_edge_represented ON access.representation_edge
    (represented_subject, id) WHERE active;
CREATE INDEX representation_edge_issuer_fk ON access.representation_edge (issuer_representation_id);
CREATE INDEX representation_edge_ceiling_fk ON access.representation_edge (ceiling_grant_id);
CREATE INDEX representation_edge_resource_fk ON access.representation_edge (resource_subject)
    WHERE resource_subject IS NOT NULL;

-- Every write takes the topology gate before its bounded cycle and degree
-- checks, including raw owner writes. Updates can only revoke, so only an
-- insert can close a cycle. A walk above 256 subjects is unavailable.
CREATE FUNCTION access.guard_representation_edge() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE degree integer; visited integer; reached boolean;
BEGIN
    PERFORM 1 FROM access.scope_gate WHERE id = 'access:representation-topology' FOR UPDATE;
    IF NOT NEW.active OR NEW.generation <> 0 THEN
        RAISE EXCEPTION 'representation edge must start active' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO degree FROM (SELECT 1 FROM access.representation_edge
        WHERE representative_subject = NEW.representative_subject AND active LIMIT 16) d;
    IF degree >= 16 THEN
        RAISE EXCEPTION 'representation edge degree limit' USING ERRCODE = '54000';
    END IF;
    SELECT count(*) INTO degree FROM (SELECT 1 FROM access.representation_edge
        WHERE represented_subject = NEW.represented_subject AND active LIMIT 16) d;
    IF degree >= 16 THEN
        RAISE EXCEPTION 'representation edge degree limit' USING ERRCODE = '54000';
    END IF;
    WITH RECURSIVE reach(subject) AS (
        SELECT NEW.represented_subject
        UNION
        SELECT e.represented_subject FROM access.representation_edge e
        JOIN reach r ON e.representative_subject = r.subject
        WHERE e.active
    ) SELECT count(*), coalesce(bool_or(subject = NEW.representative_subject), false)
        INTO visited, reached FROM (SELECT subject FROM reach LIMIT 257) bounded;
    IF reached THEN
        RAISE EXCEPTION 'representation cycle' USING ERRCODE = '23514';
    ELSIF visited > 256 THEN
        RAISE EXCEPTION 'representation topology walk limit' USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representation_edge_guard BEFORE INSERT ON access.representation_edge
    FOR EACH ROW EXECUTE FUNCTION access.guard_representation_edge();

CREATE FUNCTION access.keep_representation_edge_episode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'representation edge identity cannot be erased' USING ERRCODE = '23514';
    ELSIF (to_jsonb(NEW) - 'active' - 'generation') <> (to_jsonb(OLD) - 'active' - 'generation')
        OR NOT OLD.active OR NEW.active THEN
        RAISE EXCEPTION 'representation edge payload is immutable; only revoke is allowed'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representation_edge_episode BEFORE UPDATE OR DELETE
    ON access.representation_edge FOR EACH ROW
    EXECUTE FUNCTION access.keep_representation_edge_episode();
CREATE TRIGGER representation_edge_generation_advance BEFORE UPDATE
    ON access.representation_edge FOR EACH ROW
    EXECUTE FUNCTION access.advance_authority_generation();

CREATE FUNCTION access.bump_representation_topology_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1
    WHERE id = 'access:representation-topology';
    RETURN NULL;
END $$;
CREATE TRIGGER representation_edge_topology_epoch AFTER INSERT OR UPDATE
    ON access.representation_edge FOR EACH ROW
    EXECUTE FUNCTION access.bump_representation_topology_epoch();

-- One immutable selected path: the principal's first-hop mandate, then 0..8
-- ordered edges ending at the acting subject. Claims recheck every pinned
-- generation; a replacement path is a new proof, never an edit of this one.
CREATE TABLE access.representation_path_proof (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
    representation_id uuid NOT NULL,
    representation_generation bigint NOT NULL CHECK (representation_generation >= 0),
    origin_subject text NOT NULL,
    acting_subject text NOT NULL REFERENCES access.authority_subject(id),
    action text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
    edge_count smallint NOT NULL CHECK (edge_count BETWEEN 0 AND 8),
    topology_epoch bigint NOT NULL CHECK (topology_epoch >= 0),
    valid_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, principal_id, acting_subject, action),
    CHECK ((edge_count = 0) = (origin_subject = acting_subject)),
    FOREIGN KEY (representation_id, principal_id, origin_subject, action)
        REFERENCES access.representation(id, principal_id, subject_id, action)
);
CREATE INDEX representation_path_proof_representation_fk
    ON access.representation_path_proof (representation_id);
CREATE INDEX representation_path_proof_principal ON access.representation_path_proof
    (principal_id, acting_subject, action, id);

CREATE TABLE access.representation_path_step (
    path_id uuid NOT NULL REFERENCES access.representation_path_proof(id),
    position smallint NOT NULL CHECK (position BETWEEN 1 AND 8),
    edge_id uuid NOT NULL,
    edge_generation bigint NOT NULL CHECK (edge_generation >= 0),
    representative_subject text NOT NULL,
    represented_subject text NOT NULL,
    action text NOT NULL,
    PRIMARY KEY (path_id, position),
    FOREIGN KEY (edge_id, representative_subject, represented_subject, action)
        REFERENCES access.representation_edge(id, representative_subject, represented_subject,
            action)
);
CREATE INDEX representation_path_step_edge_fk ON access.representation_path_step (edge_id);

-- Checked at commit so a proof and its steps can be written in any order.
-- Every component must cover the whole path length and validity.
CREATE FUNCTION access.check_representation_path() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE proof record; step record; expected smallint := 0; previous text; path uuid;
BEGIN
    IF TG_TABLE_NAME = 'representation_path_proof' THEN path := NEW.id;
    ELSE path := NEW.path_id; END IF;
    SELECT p.*, r.max_path_edges AS mandate_limit, r.valid_until AS mandate_until
        INTO proof FROM access.representation_path_proof p
        JOIN access.representation r ON r.id = p.representation_id
        WHERE p.id = path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'representation path proof is missing' USING ERRCODE = '23514';
    END IF;
    IF proof.valid_until > proof.mandate_until
        OR (proof.edge_count > 0 AND proof.edge_count > proof.mandate_limit) THEN
        RAISE EXCEPTION 'representation path exceeds its mandate' USING ERRCODE = '23514';
    END IF;
    previous := proof.origin_subject;
    FOR step IN SELECT s.*, e.max_path_edges, e.valid_until, e.resource_subject
        FROM access.representation_path_step s
        JOIN access.representation_edge e ON e.id = s.edge_id
        WHERE s.path_id = path ORDER BY s.position
    LOOP
        expected := expected + 1;
        IF step.position <> expected OR step.representative_subject <> previous
            OR step.action <> proof.action OR step.max_path_edges < proof.edge_count
            OR step.valid_until < proof.valid_until THEN
            RAISE EXCEPTION 'representation path is not one bounded chain' USING ERRCODE = '23514';
        END IF;
        previous := step.represented_subject;
    END LOOP;
    IF expected <> proof.edge_count OR previous <> proof.acting_subject THEN
        RAISE EXCEPTION 'representation path is not one bounded chain' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER representation_path_proof_chain AFTER INSERT
    ON access.representation_path_proof DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION access.check_representation_path();
CREATE CONSTRAINT TRIGGER representation_path_step_chain AFTER INSERT
    ON access.representation_path_step DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION access.check_representation_path();
CREATE TRIGGER representation_path_proof_immutable BEFORE UPDATE OR DELETE
    ON access.representation_path_proof FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();
CREATE TRIGGER representation_path_step_immutable BEFORE UPDATE OR DELETE
    ON access.representation_path_step FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();

-- A compound command records one complete proof per distinct obligation. The
-- composite keys make the path, grant source, acting subject, scope and action
-- agree inside each row, so partial paths cannot be pooled into one obligation.
-- Existing single-proof admissions keep their admission columns.
CREATE TABLE access.admission_obligation (
    admission_id uuid NOT NULL REFERENCES access.admission(id),
    obligation text NOT NULL CHECK (length(obligation) BETWEEN 1 AND 128),
    principal_id uuid NOT NULL,
    acting_subject text NOT NULL,
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    path_id uuid NOT NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('grant', 'group', 'role-binding')),
    grant_id uuid,
    grant_generation bigint CHECK (grant_generation >= 0),
    group_member_id uuid,
    group_grant_id uuid,
    group_generation bigint CHECK (group_generation >= 0),
    role_binding_id uuid,
    role_binding_generation bigint CHECK (role_binding_generation >= 0),
    role_family_id uuid,
    role_revision bigint,
    PRIMARY KEY (admission_id, obligation),
    FOREIGN KEY (path_id, principal_id, acting_subject, obligation)
        REFERENCES access.representation_path_proof(id, principal_id, acting_subject, action),
    FOREIGN KEY (grant_id, acting_subject, scope_id, obligation)
        REFERENCES access.permission_grant(id, recipient_subject, scope_id, action),
    FOREIGN KEY (group_member_id, acting_subject)
        REFERENCES access.group_member(id, agent_subject),
    FOREIGN KEY (group_grant_id, scope_id, obligation)
        REFERENCES access.group_permission_grant(id, scope_id, action),
    FOREIGN KEY (role_binding_id, acting_subject, role_family_id, role_revision)
        REFERENCES access.role_binding(id, recipient_subject, family_id, role_revision),
    CHECK ((source_kind = 'grant') = (grant_id IS NOT NULL AND grant_generation IS NOT NULL)),
    CHECK ((source_kind = 'group') = (group_member_id IS NOT NULL AND group_grant_id IS NOT NULL
        AND group_generation IS NOT NULL)),
    CHECK ((source_kind = 'role-binding') = (role_binding_id IS NOT NULL
        AND role_binding_generation IS NOT NULL AND role_family_id IS NOT NULL
        AND role_revision IS NOT NULL)),
    CHECK (num_nonnulls(grant_id, group_member_id, role_binding_id) = 1)
);
CREATE INDEX admission_obligation_path_fk ON access.admission_obligation (path_id);
CREATE INDEX admission_obligation_grant_fk ON access.admission_obligation (grant_id)
    WHERE grant_id IS NOT NULL;
CREATE INDEX admission_obligation_group_member_fk ON access.admission_obligation (group_member_id)
    WHERE group_member_id IS NOT NULL;
CREATE INDEX admission_obligation_group_grant_fk ON access.admission_obligation (group_grant_id)
    WHERE group_grant_id IS NOT NULL;
CREATE INDEX admission_obligation_role_binding_fk ON access.admission_obligation (role_binding_id)
    WHERE role_binding_id IS NOT NULL;

CREATE FUNCTION access.check_admission_obligation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE covered boolean;
BEGIN
    PERFORM 1 FROM access.admission
        WHERE id = NEW.admission_id AND principal_id = NEW.principal_id
            AND acting_subject = NEW.acting_subject AND scope_id = NEW.scope_id
            AND authority_path = 'represented-agent';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'obligation is outside its admitted acting context' USING ERRCODE = '23514';
    END IF;
    IF NEW.source_kind = 'group' THEN
        WITH RECURSIVE ancestors(id, parent_id, depth) AS (
            SELECT g.id, g.parent_id, 0 FROM access.group_member m
            JOIN access.recipient_group g ON g.id = m.group_id
            WHERE m.id = NEW.group_member_id AND g.scope_id = NEW.scope_id
            UNION ALL
            SELECT p.id, p.parent_id, a.depth + 1 FROM access.recipient_group p
            JOIN ancestors a ON p.id = a.parent_id WHERE a.depth < 32
        ) SELECT EXISTS (SELECT 1 FROM ancestors a JOIN access.group_permission_grant gg
            ON gg.group_id = a.id WHERE gg.id = NEW.group_grant_id) INTO covered;
    ELSIF NEW.source_kind = 'role-binding' THEN
        SELECT permissions @> ARRAY[NEW.obligation] INTO covered FROM access.role_revision
            WHERE family_id = NEW.role_family_id AND revision = NEW.role_revision;
    ELSE
        covered := true;
    END IF;
    IF covered IS NOT TRUE THEN
        RAISE EXCEPTION 'obligation source does not cover its action' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER admission_obligation_context BEFORE INSERT ON access.admission_obligation
    FOR EACH ROW EXECUTE FUNCTION access.check_admission_obligation();
CREATE TRIGGER admission_obligation_immutable BEFORE UPDATE OR DELETE
    ON access.admission_obligation FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();

-- One principal/key/intent receipt model for the topology, protected-change,
-- representative-policy, automation, Agent-control and invitation families,
-- matching the existing per-family Access receipts. The result replays exactly.
CREATE TABLE access.authority_control_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    family text NOT NULL CHECK (family IN ('representation-edge', 'representation-path',
        'protected-change', 'representative-policy', 'automation', 'agent-control',
        'agent-recovery', 'agent-invitation')),
    operation text NOT NULL CHECK (operation ~ '^[a-z][a-z-]{0,63}$'),
    subject text REFERENCES access.authority_subject(id),
    object_id uuid NOT NULL,
    result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 0),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'
        AND octet_length(result::text) <= 4096),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, idempotency_key)
);
CREATE INDEX authority_control_receipt_object ON access.authority_control_receipt
    (family, object_id);
CREATE TRIGGER authority_control_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.authority_control_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();
