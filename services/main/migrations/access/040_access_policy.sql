-- One governing policy per existing scope gate (IAM15-IAM17, IAM19, IAM22).
-- Immutable revisions pin the declared combining algorithm, mandatory guards,
-- ordered first-applicable rules, typed condition IR and evaluation limits.
-- Publishing, and admitting or revoking a referenced set, advance the existing
-- scope_gate.authority_epoch; there is no policy-specific epoch.
CREATE FUNCTION access.reject_policy_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable Access policy, decision or revocation record'
        USING ERRCODE = '23514';
END $$;

CREATE TABLE access.policy (
    id uuid PRIMARY KEY,
    scope_id text NOT NULL UNIQUE REFERENCES access.scope_gate(id),
    owner_subject text NOT NULL REFERENCES access.authority_subject(id),
    head_revision bigint NOT NULL CHECK (head_revision >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, scope_id)
);
CREATE INDEX policy_owner_page ON access.policy (owner_subject, id);

-- The publisher's representation and management grant are the approval basis.
-- Limits belong to the pinned profile; lowering them needs a new profile.
CREATE TABLE access.policy_revision (
    policy_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 1),
    scope_id text NOT NULL,
    profile text NOT NULL CHECK (profile = 'access-policy-v1'),
    combining_algorithm text NOT NULL CHECK (combining_algorithm = 'first-applicable'),
    default_effect text NOT NULL CHECK (default_effect = 'deny'),
    mandatory_count smallint NOT NULL CHECK (mandatory_count BETWEEN 0 AND 16),
    ordered_count smallint NOT NULL CHECK (ordered_count BETWEEN 0 AND 64),
    reference_count smallint NOT NULL CHECK (reference_count BETWEEN 0 AND 16),
    max_states integer NOT NULL CHECK (max_states BETWEEN 1 AND 2048),
    max_input_rows integer NOT NULL CHECK (max_input_rows BETWEEN 1 AND 4096),
    deadline_ms integer NOT NULL CHECK (deadline_ms BETWEEN 1 AND 5000),
    digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    published_by_principal uuid NOT NULL REFERENCES access.principal(id),
    publisher_subject text NOT NULL REFERENCES access.authority_subject(id),
    publisher_representation_id uuid NOT NULL REFERENCES access.representation(id),
    publisher_representation_generation bigint NOT NULL
        CHECK (publisher_representation_generation >= 0),
    publisher_grant_id uuid NOT NULL REFERENCES access.permission_grant(id),
    publisher_grant_generation bigint NOT NULL CHECK (publisher_grant_generation >= 0),
    result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (policy_id, revision),
    FOREIGN KEY (policy_id, scope_id) REFERENCES access.policy(id, scope_id)
);
CREATE INDEX policy_revision_publisher_fk ON access.policy_revision (published_by_principal);
ALTER TABLE access.policy ADD CONSTRAINT policy_head_revision_fk
    FOREIGN KEY (id, head_revision) REFERENCES access.policy_revision(policy_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

-- Mandatory rules are conjunctive `require` guards evaluated before every
-- ordered rule, so no ordered exception can bypass them. Ordered rules are
-- first-applicable. The compiler validates the full condition IR; the database
-- keeps the closed top-level registry, byte bound and explicit action list.
CREATE TABLE access.policy_rule (
    policy_id uuid NOT NULL,
    revision bigint NOT NULL,
    tier text NOT NULL CHECK (tier IN ('mandatory', 'ordered')),
    position smallint NOT NULL CHECK (position BETWEEN 1 AND 64),
    rule_id uuid NOT NULL,
    effect text NOT NULL,
    actions text[] NOT NULL,
    condition jsonb NOT NULL,
    PRIMARY KEY (policy_id, revision, tier, position),
    UNIQUE (policy_id, revision, rule_id),
    UNIQUE (policy_id, revision, tier, position, rule_id),
    FOREIGN KEY (policy_id, revision) REFERENCES access.policy_revision(policy_id, revision),
    CONSTRAINT policy_rule_tier_effect CHECK (
        (tier = 'mandatory' AND effect = 'require' AND position <= 16)
        OR (tier = 'ordered' AND effect IN ('allow', 'deny'))),
    CONSTRAINT policy_rule_explicit_actions CHECK (
        cardinality(actions) BETWEEN 1 AND 16 AND array_ndims(actions) = 1
        AND array_position(actions, NULL) IS NULL
        AND array_to_string(actions, ' ')
            ~ '^[a-z][a-z0-9.-]{0,127}( [a-z][a-z0-9.-]{0,127})*$'),
    CONSTRAINT policy_rule_condition_registry CHECK (
        jsonb_typeof(condition) = 'object'
        AND condition->>'op' IN ('all', 'any', 'not', 'authenticated', 'subject-is',
            'member-of', 'has-grant', 'represents', 'time-window')
        AND octet_length(condition::text) <= 4096)
);

-- A set owner admits exactly one referencing scope, basis and purpose. A policy
-- may only name an active admission; later revocation or expiry makes the
-- condition unavailable at evaluation, never proof of non-membership.
CREATE TABLE access.policy_set_admission (
    id uuid PRIMARY KEY,
    set_kind text NOT NULL,
    set_owner_subject text NOT NULL,
    basis text NOT NULL CHECK (basis IN ('authenticated_principal', 'acting_subject')),
    referencing_scope_id text NOT NULL REFERENCES access.scope_gate(id),
    purpose text NOT NULL CHECK (purpose IN ('resource-exclusion', 'resource-eligibility')),
    admitted_by_principal uuid NOT NULL REFERENCES access.principal(id),
    admitting_representation_id uuid NOT NULL REFERENCES access.representation(id),
    admitting_representation_generation bigint NOT NULL
        CHECK (admitting_representation_generation >= 0),
    active boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    valid_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (set_kind, set_owner_subject)
        REFERENCES access.membership_policy(kind, owner_subject),
    CHECK (valid_until > created_at)
);
CREATE UNIQUE INDEX policy_set_admission_live ON access.policy_set_admission
    (referencing_scope_id, set_kind, set_owner_subject, basis, purpose) WHERE active;
CREATE INDEX policy_set_admission_owner_page ON access.policy_set_admission
    (set_owner_subject, id);

CREATE FUNCTION access.keep_policy_set_admission_episode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.set_kind, NEW.set_owner_subject, NEW.basis, NEW.referencing_scope_id,
        NEW.purpose, NEW.admitted_by_principal, NEW.admitting_representation_id,
        NEW.admitting_representation_generation, NEW.valid_until, NEW.created_at)
        IS DISTINCT FROM
       (OLD.id, OLD.set_kind, OLD.set_owner_subject, OLD.basis, OLD.referencing_scope_id,
        OLD.purpose, OLD.admitted_by_principal, OLD.admitting_representation_id,
        OLD.admitting_representation_generation, OLD.valid_until, OLD.created_at)
        OR (NOT OLD.active AND NEW.active) THEN
        RAISE EXCEPTION 'policy set admission episode is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER policy_set_admission_episode BEFORE UPDATE
    ON access.policy_set_admission FOR EACH ROW
    EXECUTE FUNCTION access.keep_policy_set_admission_episode();
CREATE TRIGGER policy_set_admission_generation_advance BEFORE UPDATE
    ON access.policy_set_admission FOR EACH ROW
    EXECUTE FUNCTION access.advance_authority_generation();
CREATE TRIGGER policy_set_admission_retained BEFORE DELETE
    ON access.policy_set_admission FOR EACH ROW
    EXECUTE FUNCTION access.reject_policy_record_mutation();

-- Normalized references let the owner find every revision naming a set without
-- scanning condition JSON. Polarity is the compiler's use of the set.
CREATE TABLE access.policy_rule_set_reference (
    policy_id uuid NOT NULL,
    revision bigint NOT NULL,
    rule_id uuid NOT NULL,
    set_admission_id uuid NOT NULL REFERENCES access.policy_set_admission(id),
    polarity text NOT NULL CHECK (polarity IN ('exclude', 'include')),
    PRIMARY KEY (policy_id, revision, rule_id, set_admission_id),
    FOREIGN KEY (policy_id, revision, rule_id)
        REFERENCES access.policy_rule(policy_id, revision, rule_id)
);
CREATE INDEX policy_rule_set_reference_admission ON access.policy_rule_set_reference
    (set_admission_id, policy_id, revision);

CREATE FUNCTION access.check_policy_set_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE admission record; referencing_scope text; rule_condition jsonb;
BEGIN
    SELECT a.* INTO admission FROM access.policy_set_admission a
        WHERE a.id = NEW.set_admission_id FOR SHARE;
    SELECT r.scope_id, pr.condition INTO referencing_scope, rule_condition
        FROM access.policy_revision r JOIN access.policy_rule pr
          ON pr.policy_id = r.policy_id AND pr.revision = r.revision
        WHERE r.policy_id = NEW.policy_id AND r.revision = NEW.revision
          AND pr.rule_id = NEW.rule_id;
    IF NOT admission.active OR admission.valid_until <= clock_timestamp()
        OR admission.referencing_scope_id IS DISTINCT FROM referencing_scope
        OR (admission.purpose = 'resource-exclusion') <> (NEW.polarity = 'exclude')
        OR NOT jsonb_path_exists(rule_condition,
            '$.** ? (@.op == "member-of" && @.admission == $id && @.basis == $basis)',
            jsonb_build_object('id', NEW.set_admission_id::text, 'basis', admission.basis)) THEN
        RAISE EXCEPTION 'policy set reference is not admitted for this rule'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER policy_rule_set_reference_admitted BEFORE INSERT
    ON access.policy_rule_set_reference FOR EACH ROW
    EXECUTE FUNCTION access.check_policy_set_reference();

-- A revision is created as the next head and its declared rule/reference
-- counts must hold at every commit, so no later row can extend it. Every
-- `member-of` mention has exactly one admitted reference row.
CREATE FUNCTION access.check_policy_revision_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE head bigint;
BEGIN
    SELECT head_revision INTO head FROM access.policy WHERE id = NEW.policy_id FOR UPDATE;
    IF head IS NULL OR NOT (NEW.revision = head + 1 OR (NEW.revision = 1 AND head = 1)) THEN
        RAISE EXCEPTION 'policy revision must be the next head' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER policy_revision_next_head BEFORE INSERT
    ON access.policy_revision FOR EACH ROW
    EXECUTE FUNCTION access.check_policy_revision_insert();

CREATE FUNCTION access.check_policy_revision_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE declared record; counted record; refs integer; mentions integer;
BEGIN
    SELECT r.mandatory_count, r.ordered_count, r.reference_count, p.head_revision
        INTO declared FROM access.policy_revision r JOIN access.policy p ON p.id = r.policy_id
        WHERE r.policy_id = NEW.policy_id AND r.revision = NEW.revision;
    SELECT count(*) FILTER (WHERE tier = 'mandatory') AS mandatory_rows,
           coalesce(max(position) FILTER (WHERE tier = 'mandatory'), 0) AS mandatory_last,
           count(*) FILTER (WHERE tier = 'ordered') AS ordered_rows,
           coalesce(max(position) FILTER (WHERE tier = 'ordered'), 0) AS ordered_last
        INTO counted FROM access.policy_rule
        WHERE policy_id = NEW.policy_id AND revision = NEW.revision;
    SELECT count(*) INTO refs FROM access.policy_rule_set_reference
        WHERE policy_id = NEW.policy_id AND revision = NEW.revision;
    SELECT count(DISTINCT (r.rule_id, m.item->>'admission')) INTO mentions
        FROM access.policy_rule r
        CROSS JOIN LATERAL jsonb_path_query(r.condition, '$.** ? (@.op == "member-of")')
            AS m(item)
        WHERE r.policy_id = NEW.policy_id AND r.revision = NEW.revision;
    IF declared.head_revision < NEW.revision OR mentions <> refs
        OR counted.mandatory_rows <> declared.mandatory_count
        OR counted.mandatory_last <> declared.mandatory_count
        OR counted.ordered_rows <> declared.ordered_count
        OR counted.ordered_last <> declared.ordered_count
        OR refs <> declared.reference_count THEN
        RAISE EXCEPTION 'policy revision is incomplete or was extended'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER policy_revision_complete AFTER INSERT
    ON access.policy_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION access.check_policy_revision_complete();
CREATE CONSTRAINT TRIGGER policy_rule_revision_complete AFTER INSERT
    ON access.policy_rule DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION access.check_policy_revision_complete();
CREATE CONSTRAINT TRIGGER policy_reference_revision_complete AFTER INSERT
    ON access.policy_rule_set_reference DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION access.check_policy_revision_complete();

CREATE FUNCTION access.keep_policy_head_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
        OR NEW.owner_subject IS DISTINCT FROM OLD.owner_subject
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.head_revision <> OLD.head_revision + 1 THEN
        RAISE EXCEPTION 'policy identity is immutable and its head advances by one'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER policy_head_order BEFORE UPDATE
    ON access.policy FOR EACH ROW EXECUTE FUNCTION access.keep_policy_head_order();
CREATE TRIGGER policy_retained BEFORE DELETE
    ON access.policy FOR EACH ROW EXECUTE FUNCTION access.reject_policy_record_mutation();
CREATE TRIGGER policy_revision_immutable BEFORE UPDATE OR DELETE
    ON access.policy_revision FOR EACH ROW
    EXECUTE FUNCTION access.reject_policy_record_mutation();
CREATE TRIGGER policy_rule_immutable BEFORE UPDATE OR DELETE
    ON access.policy_rule FOR EACH ROW
    EXECUTE FUNCTION access.reject_policy_record_mutation();
CREATE TRIGGER policy_rule_set_reference_immutable BEFORE UPDATE OR DELETE
    ON access.policy_rule_set_reference FOR EACH ROW
    EXECUTE FUNCTION access.reject_policy_record_mutation();

-- Same principal/key/digest receipt shape as grant_change_receipt (017).
CREATE TABLE access.policy_change_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    action text NOT NULL CHECK (action IN ('publish-revision', 'admit-set', 'revoke-set')),
    policy_id uuid,
    policy_revision bigint,
    set_admission_id uuid REFERENCES access.policy_set_admission(id),
    result_authority_epoch bigint NOT NULL CHECK (result_authority_epoch >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key),
    FOREIGN KEY (policy_id, policy_revision)
        REFERENCES access.policy_revision(policy_id, revision),
    CHECK ((action = 'publish-revision' AND policy_id IS NOT NULL
            AND policy_revision IS NOT NULL AND set_admission_id IS NULL)
        OR (action IN ('admit-set', 'revoke-set') AND policy_id IS NULL
            AND policy_revision IS NULL AND set_admission_id IS NOT NULL))
);
CREATE TRIGGER policy_change_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.policy_change_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_policy_record_mutation();
