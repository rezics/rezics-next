-- An institution's approved representative policy caps which actions its
-- representatives may hold, for how long and how many at once. The declared
-- approval subject is the grantor that trusts this policy: a revision inside the
-- active ceiling needs no new approval, and a widening revision activates only
-- with that subject's approved protected change. Mandates name the revision they
-- were issued under, so roster replacement never rewrites an institutional grant.
CREATE TABLE access.representative_policy (
    id uuid PRIMARY KEY,
    institution_subject text NOT NULL REFERENCES access.authority_subject(id),
    approval_subject text NOT NULL REFERENCES access.authority_subject(id),
    active_revision bigint NOT NULL CHECK (active_revision BETWEEN 1 AND 1024),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    created_by_principal uuid NOT NULL REFERENCES access.principal(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, institution_subject),
    UNIQUE (id, approval_subject),
    CHECK (institution_subject <> approval_subject)
);
CREATE INDEX representative_policy_institution ON access.representative_policy
    (institution_subject, id);
CREATE INDEX representative_policy_approval_subject ON access.representative_policy
    (approval_subject, id);
CREATE INDEX representative_policy_created_by_fk ON access.representative_policy
    (created_by_principal);

CREATE TABLE access.representative_policy_revision (
    policy_id uuid NOT NULL REFERENCES access.representative_policy(id),
    revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 1024),
    base_revision bigint,
    actions text[] NOT NULL CHECK (cardinality(actions) BETWEEN 1 AND 32
        AND array_position(actions, NULL) IS NULL),
    max_representatives smallint NOT NULL CHECK (max_representatives BETWEEN 1 AND 256),
    max_mandate_days smallint NOT NULL CHECK (max_mandate_days BETWEEN 1 AND 366),
    widening boolean NOT NULL,
    protected_change_id uuid UNIQUE REFERENCES access.protected_change_activation(proposal_id),
    created_by_principal uuid NOT NULL REFERENCES access.principal(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (policy_id, revision),
    CHECK ((revision = 1) = (base_revision IS NULL)),
    CHECK (base_revision IS NULL OR base_revision = revision - 1),
    CHECK (revision > 1 OR NOT widening),
    CHECK (widening = (protected_change_id IS NOT NULL))
);
CREATE INDEX representative_policy_revision_created_by_fk
    ON access.representative_policy_revision (created_by_principal);
ALTER TABLE access.representative_policy ADD CONSTRAINT representative_policy_active_fk
    FOREIGN KEY (id, active_revision)
    REFERENCES access.representative_policy_revision(policy_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

-- The database computes widening from the base revision rather than trusting
-- the writer, and a widening revision must carry the approval subject's change.
CREATE FUNCTION access.check_representative_policy_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE policy record; base record;
BEGIN
    SELECT * INTO policy FROM access.representative_policy WHERE id = NEW.policy_id FOR UPDATE;
    IF NEW.revision = 1 THEN
        IF FOUND AND policy.active_revision <> 1 THEN
            RAISE EXCEPTION 'representative policy revision is stale' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT FOUND OR policy.active_revision <> NEW.base_revision THEN
        RAISE EXCEPTION 'representative policy revision is stale' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO base FROM access.representative_policy_revision
        WHERE policy_id = NEW.policy_id AND revision = NEW.base_revision;
    IF NEW.widening IS DISTINCT FROM NOT (NEW.actions <@ base.actions
        AND NEW.max_representatives <= base.max_representatives
        AND NEW.max_mandate_days <= base.max_mandate_days) THEN
        RAISE EXCEPTION 'representative policy widening is misclassified' USING ERRCODE = '23514';
    END IF;
    IF NEW.widening THEN
        PERFORM 1 FROM access.protected_change_activation a
            JOIN access.protected_change_proposal p ON p.id = a.proposal_id
            WHERE a.proposal_id = NEW.protected_change_id AND a.kind = 'representative-policy'
                AND a.target_object = NEW.policy_id
                AND p.approval_subject = policy.approval_subject
                AND p.expected_object_generation = policy.generation;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'widening needs its approval subject' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representative_policy_revision_guard BEFORE INSERT
    ON access.representative_policy_revision FOR EACH ROW
    EXECUTE FUNCTION access.check_representative_policy_revision();
CREATE TRIGGER representative_policy_revision_immutable BEFORE UPDATE OR DELETE
    ON access.representative_policy_revision FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();

-- Only the active revision pointer may move, one revision at a time.
CREATE FUNCTION access.keep_representative_policy_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.id IS DISTINCT FROM OLD.id
        OR NEW.institution_subject IS DISTINCT FROM OLD.institution_subject
        OR NEW.approval_subject IS DISTINCT FROM OLD.approval_subject
        OR NEW.created_by_principal IS DISTINCT FROM OLD.created_by_principal
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.active_revision <> OLD.active_revision + 1 THEN
        RAISE EXCEPTION 'representative policy identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representative_policy_identity BEFORE UPDATE OR DELETE
    ON access.representative_policy FOR EACH ROW
    EXECUTE FUNCTION access.keep_representative_policy_identity();
CREATE TRIGGER representative_policy_generation_advance BEFORE UPDATE
    ON access.representative_policy FOR EACH ROW
    EXECUTE FUNCTION access.advance_authority_generation();

ALTER TABLE access.representation
    ADD COLUMN representative_policy_id uuid,
    ADD COLUMN representative_policy_revision bigint,
    ADD CONSTRAINT representation_policy_pair CHECK
        ((representative_policy_id IS NULL) = (representative_policy_revision IS NULL)),
    ADD CONSTRAINT representation_policy_revision_fk
        FOREIGN KEY (representative_policy_id, representative_policy_revision)
        REFERENCES access.representative_policy_revision(policy_id, revision),
    ADD CONSTRAINT representation_policy_institution_fk
        FOREIGN KEY (representative_policy_id, subject_id)
        REFERENCES access.representative_policy(id, institution_subject);
CREATE INDEX representation_policy_roster ON access.representation
    (representative_policy_id, id) WHERE active AND representative_policy_id IS NOT NULL;

-- A roster mandate is issued under the active revision, inside its action,
-- lifetime and size ceiling. The policy row lock serializes roster writes.
CREATE FUNCTION access.check_policy_representation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE revision record; roster integer;
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.representative_policy_id, NEW.representative_policy_revision)
        IS DISTINCT FROM (OLD.representative_policy_id, OLD.representative_policy_revision) THEN
        RAISE EXCEPTION 'mandate policy basis is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.representative_policy_id IS NULL OR NOT NEW.active
        OR (TG_OP = 'UPDATE' AND OLD.active) THEN
        RETURN NEW;
    END IF;
    SELECT r.* INTO revision FROM access.representative_policy p
        JOIN access.representative_policy_revision r
            ON r.policy_id = p.id AND r.revision = p.active_revision
        WHERE p.id = NEW.representative_policy_id FOR UPDATE OF p;
    SELECT count(*) INTO roster FROM (SELECT 1 FROM access.representation
        WHERE representative_policy_id = NEW.representative_policy_id AND active
            AND valid_until > clock_timestamp() AND id <> NEW.id
        LIMIT 256) live;
    IF revision.revision IS DISTINCT FROM NEW.representative_policy_revision
        OR NOT NEW.action = ANY(revision.actions)
        OR NEW.valid_until > clock_timestamp() + make_interval(days => revision.max_mandate_days)
        OR roster >= revision.max_representatives THEN
        RAISE EXCEPTION 'mandate exceeds its representative policy' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representation_policy_roster BEFORE INSERT OR UPDATE
    ON access.representation FOR EACH ROW
    EXECUTE FUNCTION access.check_policy_representation();
