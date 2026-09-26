-- One authority decision frame (IAM20, IAM22, IAM29, IAM33). The row ID is the
-- opaque decision identity and proof handle. It reuses the existing scope epoch,
-- group generation, principal enforcement epoch, subject generation, recovery
-- generation and row generations; it defines no epoch of its own. The insert
-- guards require every recorded epoch and input generation to equal what the
-- inserting transaction observes, so a frame assembled from different authority
-- snapshots cannot be stored. Reuse revalidates the same inputs.
CREATE TABLE access.decision_snapshot (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('policy', 'interaction')),
    audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 256),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
    acting_subject text REFERENCES access.authority_subject(id),
    acting_subject_generation bigint CHECK (acting_subject_generation >= 0),
    action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9.-]{0,127}$'),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
    group_generation bigint NOT NULL CHECK (group_generation >= 0),
    recovery_generation bigint NOT NULL CHECK (recovery_generation >= 0),
    policy_id uuid,
    policy_revision bigint,
    recipient_subject text REFERENCES access.authority_subject(id),
    input_snapshot text NOT NULL CHECK (input_snapshot ~ '^[0-9]+:[0-9]+:[0-9,]*$'),
    outcome text NOT NULL
        CHECK (outcome IN ('allow', 'deny', 'not-applicable', 'indeterminate')),
    public_result text NOT NULL,
    reason text NOT NULL,
    deciding_tier text CHECK (deciding_tier IN ('mandatory', 'ordered')),
    deciding_position smallint CHECK (deciding_position BETWEEN 1 AND 64),
    deciding_rule_id uuid,
    rule_trace jsonb NOT NULL CHECK (jsonb_typeof(rule_trace) = 'array'
        AND jsonb_array_length(rule_trace) <= 80),
    evaluated_states integer NOT NULL CHECK (evaluated_states BETWEEN 0 AND 2048),
    evaluated_rows integer NOT NULL CHECK (evaluated_rows BETWEEN 0 AND 4096),
    reusable boolean NOT NULL,
    decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    FOREIGN KEY (policy_id, scope_id) REFERENCES access.policy(id, scope_id),
    FOREIGN KEY (policy_id, policy_revision)
        REFERENCES access.policy_revision(policy_id, revision),
    FOREIGN KEY (policy_id, policy_revision, deciding_tier, deciding_position, deciding_rule_id)
        REFERENCES access.policy_rule(policy_id, revision, tier, position, rule_id),
    CONSTRAINT decision_actor_pair CHECK
        ((acting_subject IS NULL) = (acting_subject_generation IS NULL)),
    CONSTRAINT decision_validity CHECK
        (expires_at > decided_at AND expires_at <= decided_at + interval '5 minutes'),
    -- Unknown evidence is never public allow and never public absence.
    CONSTRAINT decision_public_result CHECK (
        (outcome = 'allow' AND public_result = 'allow')
        OR (outcome IN ('deny', 'not-applicable') AND public_result = 'deny')
        OR (outcome = 'indeterminate' AND public_result = 'unavailable')),
    CONSTRAINT decision_reason CHECK (
        (outcome = 'allow' AND reason IN ('rule-allow', 'interaction-permitted'))
        OR (outcome = 'deny' AND reason IN ('rule-deny', 'mandatory-guard-failed',
            'scope-closed', 'interaction-blocked'))
        OR (outcome = 'not-applicable' AND reason = 'no-applicable-rule')
        OR (outcome = 'indeterminate' AND reason IN ('evidence-unavailable',
            'set-admission-unavailable', 'budget-exhausted'))),
    CONSTRAINT decision_deciding_rule CHECK (
        (deciding_tier IS NULL AND deciding_position IS NULL AND deciding_rule_id IS NULL)
        OR (deciding_tier IS NOT NULL AND deciding_position IS NOT NULL
            AND deciding_rule_id IS NOT NULL)),
    CONSTRAINT decision_kind_fields CHECK (
        (kind = 'policy' AND policy_id IS NOT NULL AND policy_revision IS NOT NULL
            AND recipient_subject IS NULL
            AND reason NOT IN ('interaction-permitted', 'interaction-blocked')
            AND (reason NOT IN ('rule-allow', 'rule-deny') OR deciding_tier = 'ordered')
            AND (reason <> 'mandatory-guard-failed' OR deciding_tier = 'mandatory')
            AND (reason NOT IN ('no-applicable-rule', 'scope-closed') OR deciding_tier IS NULL))
        OR (kind = 'interaction' AND policy_id IS NULL AND policy_revision IS NULL
            AND recipient_subject IS NOT NULL AND deciding_tier IS NULL
            AND scope_id = 'interaction:' || recipient_subject
            AND action IN ('interaction.message', 'interaction.reply', 'interaction.mention')
            AND reason NOT IN ('rule-allow', 'rule-deny', 'mandatory-guard-failed',
                'no-applicable-rule')))
);
CREATE INDEX decision_snapshot_expiry ON access.decision_snapshot (expires_at, id);

-- Trace entries are the rules evaluated in order up to the deciding one:
-- mandatory {pass, fail, unknown}; ordered {match, no-match, unknown}.
CREATE FUNCTION access.check_decision_snapshot_frame() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE mandatory_rules integer; rule_effect text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM access.scope_gate WHERE id = NEW.scope_id
            AND authority_epoch = NEW.authority_epoch
            AND group_generation = NEW.group_generation)
        OR NOT EXISTS (SELECT 1 FROM access.principal WHERE id = NEW.principal_id
            AND enforcement_epoch = NEW.principal_epoch)
        OR NOT EXISTS (SELECT 1 FROM access.recovery_fence WHERE id
            AND generation = NEW.recovery_generation)
        OR (NEW.acting_subject IS NOT NULL AND NOT EXISTS (SELECT 1
            FROM access.authority_subject WHERE id = NEW.acting_subject
            AND generation = NEW.acting_subject_generation))
        OR (NEW.kind = 'policy' AND NOT EXISTS (SELECT 1 FROM access.policy
            WHERE id = NEW.policy_id AND head_revision = NEW.policy_revision)) THEN
        RAISE EXCEPTION 'decision frame does not match one authority snapshot'
            USING ERRCODE = '23514';
    END IF;
    -- Missing or mistyped members make the inner filter empty, so they fail too.
    IF jsonb_path_exists(NEW.rule_trace, '$[*] ? (!exists(@ ? (
            (@.tier == "mandatory"
                && (@.outcome == "pass" || @.outcome == "fail" || @.outcome == "unknown"))
            || (@.tier == "ordered"
                && (@.outcome == "match" || @.outcome == "no-match" || @.outcome == "unknown")))
          ? (@.position.type() == "number" && @.position >= 1 && @.position <= 64)))') THEN
        RAISE EXCEPTION 'decision trace entry is outside the registry' USING ERRCODE = '23514';
    END IF;
    IF NEW.outcome = 'allow' AND jsonb_path_exists(NEW.rule_trace,
        '$[*] ? (@.outcome == "unknown" || @.outcome == "fail")') THEN
        RAISE EXCEPTION 'failed or unresolved evidence cannot become allow'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'policy' AND NEW.deciding_rule_id IS NOT NULL THEN
        SELECT effect INTO rule_effect FROM access.policy_rule
            WHERE policy_id = NEW.policy_id AND revision = NEW.policy_revision
              AND rule_id = NEW.deciding_rule_id;
        IF (NEW.reason = 'rule-allow' AND rule_effect <> 'allow')
            OR (NEW.reason = 'rule-deny' AND rule_effect <> 'deny') THEN
            RAISE EXCEPTION 'decision reason differs from the deciding rule effect'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.kind = 'policy' AND NEW.outcome = 'allow' THEN
        -- Every mandatory guard passed, then ordered rules 1..n-1 did not match
        -- and rule n matched: the stored allow follows first-applicable.
        SELECT mandatory_count INTO mandatory_rules FROM access.policy_revision
            WHERE policy_id = NEW.policy_id AND revision = NEW.policy_revision;
        IF jsonb_array_length(jsonb_path_query_array(NEW.rule_trace,
                '$[*] ? (@.tier == "mandatory" && @.outcome == "pass")')) <> mandatory_rules
            OR jsonb_array_length(jsonb_path_query_array(NEW.rule_trace,
                '$[*] ? (@.tier == "ordered" && @.outcome == "no-match" && @.position < $n)',
                jsonb_build_object('n', NEW.deciding_position))) <> NEW.deciding_position - 1
            OR NOT jsonb_path_exists(NEW.rule_trace,
                '$[*] ? (@.tier == "ordered" && @.outcome == "match" && @.position == $n)',
                jsonb_build_object('n', NEW.deciding_position)) THEN
            RAISE EXCEPTION 'allow does not follow mandatory guards and first-applicable order'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER decision_snapshot_frame BEFORE INSERT
    ON access.decision_snapshot FOR EACH ROW
    EXECUTE FUNCTION access.check_decision_snapshot_frame();

CREATE FUNCTION access.retain_unexpired_decision_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' OR OLD.expires_at > clock_timestamp() THEN
        RAISE EXCEPTION 'decision snapshot is immutable until it expires'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER decision_snapshot_immutable BEFORE UPDATE OR DELETE
    ON access.decision_snapshot FOR EACH ROW
    EXECUTE FUNCTION access.retain_unexpired_decision_snapshot();

-- Selected proofs and condition evidence. `absent` is an observed missing
-- membership tuple; `unavailable` is unresolved evidence, never non-membership.
CREATE TABLE access.decision_snapshot_input (
    decision_id uuid NOT NULL REFERENCES access.decision_snapshot(id) ON DELETE CASCADE,
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 64),
    role text NOT NULL CHECK (role IN ('guard', 'condition', 'proof')),
    kind text NOT NULL CHECK (kind IN ('representation', 'permission_grant',
        'principal_permission_grant', 'group_member', 'group_permission_grant',
        'role_binding', 'private_group_member', 'private_role_binding', 'membership',
        'private_membership', 'policy_set_admission', 'interaction_block')),
    observed text NOT NULL CHECK (observed IN ('present', 'absent', 'unavailable')),
    object_generation bigint CHECK (object_generation >= 0),
    representation_id uuid REFERENCES access.representation(id),
    permission_grant_id uuid REFERENCES access.permission_grant(id),
    principal_permission_grant_id uuid REFERENCES access.principal_permission_grant(id),
    group_member_id uuid REFERENCES access.group_member(id),
    group_permission_grant_id uuid REFERENCES access.group_permission_grant(id),
    role_binding_id uuid REFERENCES access.role_binding(id),
    private_group_member_id uuid REFERENCES access.private_group_member(id),
    private_role_binding_id uuid REFERENCES access.private_role_binding(id),
    membership_id uuid REFERENCES access.membership(id),
    private_membership_id uuid REFERENCES access.private_membership(id),
    set_admission_id uuid REFERENCES access.policy_set_admission(id),
    interaction_block_id uuid REFERENCES access.interaction_block(id),
    set_kind text,
    set_owner_subject text,
    PRIMARY KEY (decision_id, ordinal),
    FOREIGN KEY (set_kind, set_owner_subject)
        REFERENCES access.membership_policy(kind, owner_subject),
    CONSTRAINT decision_input_one_object CHECK (num_nonnulls(representation_id,
        permission_grant_id, principal_permission_grant_id, group_member_id,
        group_permission_grant_id, role_binding_id, private_group_member_id,
        private_role_binding_id, membership_id, private_membership_id, set_admission_id,
        interaction_block_id) = CASE WHEN object_generation IS NULL THEN 0 ELSE 1 END),
    CONSTRAINT decision_input_kind_object CHECK (object_generation IS NULL OR CASE kind
        WHEN 'representation' THEN representation_id IS NOT NULL
        WHEN 'permission_grant' THEN permission_grant_id IS NOT NULL
        WHEN 'principal_permission_grant' THEN principal_permission_grant_id IS NOT NULL
        WHEN 'group_member' THEN group_member_id IS NOT NULL
        WHEN 'group_permission_grant' THEN group_permission_grant_id IS NOT NULL
        WHEN 'role_binding' THEN role_binding_id IS NOT NULL
        WHEN 'private_group_member' THEN private_group_member_id IS NOT NULL
        WHEN 'private_role_binding' THEN private_role_binding_id IS NOT NULL
        WHEN 'membership' THEN membership_id IS NOT NULL
        WHEN 'private_membership' THEN private_membership_id IS NOT NULL
        WHEN 'policy_set_admission' THEN set_admission_id IS NOT NULL
        ELSE interaction_block_id IS NOT NULL END),
    CONSTRAINT decision_input_observation CHECK (CASE
        WHEN kind IN ('membership', 'private_membership') THEN
            set_kind IS NOT NULL AND set_owner_subject IS NOT NULL
            AND (observed = 'present') = (object_generation IS NOT NULL)
        WHEN kind = 'policy_set_admission' THEN
            set_kind IS NULL AND observed IN ('present', 'unavailable')
            AND object_generation IS NOT NULL
        ELSE set_kind IS NULL AND observed = 'present' AND object_generation IS NOT NULL END)
);
CREATE INDEX decision_snapshot_input_set_admission ON access.decision_snapshot_input
    (set_admission_id) WHERE set_admission_id IS NOT NULL;

CREATE FUNCTION access.check_decision_snapshot_input() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE frame record; current_id uuid; current_generation bigint;
    admission_live boolean;
BEGIN
    SELECT principal_id, acting_subject, decided_at INTO frame
        FROM access.decision_snapshot WHERE id = NEW.decision_id;
    IF NEW.kind = 'membership' THEN
        IF frame.acting_subject IS NULL THEN
            RAISE EXCEPTION 'acting-subject membership needs a selected actor'
                USING ERRCODE = '23514';
        END IF;
        SELECT id, generation INTO current_id, current_generation FROM access.membership
            WHERE kind = NEW.set_kind AND owner_subject = NEW.set_owner_subject
              AND member_subject = frame.acting_subject;
    ELSIF NEW.kind = 'private_membership' THEN
        SELECT id, generation INTO current_id, current_generation
            FROM access.private_membership
            WHERE kind = NEW.set_kind AND owner_subject = NEW.set_owner_subject
              AND principal_id = frame.principal_id;
    END IF;
    IF NEW.kind IN ('membership', 'private_membership') THEN
        IF (NEW.observed = 'absent' AND current_id IS NOT NULL)
            OR (NEW.observed = 'present' AND (current_id IS DISTINCT FROM
                coalesce(NEW.membership_id, NEW.private_membership_id)
                OR current_generation IS DISTINCT FROM NEW.object_generation)) THEN
            RAISE EXCEPTION 'decision input differs from the frame snapshot'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    CASE NEW.kind
    WHEN 'representation' THEN SELECT generation INTO current_generation
        FROM access.representation WHERE id = NEW.representation_id;
    WHEN 'permission_grant' THEN SELECT generation INTO current_generation
        FROM access.permission_grant WHERE id = NEW.permission_grant_id;
    WHEN 'principal_permission_grant' THEN SELECT generation INTO current_generation
        FROM access.principal_permission_grant WHERE id = NEW.principal_permission_grant_id;
    WHEN 'group_member' THEN SELECT generation INTO current_generation
        FROM access.group_member WHERE id = NEW.group_member_id;
    WHEN 'group_permission_grant' THEN SELECT generation INTO current_generation
        FROM access.group_permission_grant WHERE id = NEW.group_permission_grant_id;
    WHEN 'role_binding' THEN SELECT generation INTO current_generation
        FROM access.role_binding WHERE id = NEW.role_binding_id;
    WHEN 'private_group_member' THEN SELECT generation INTO current_generation
        FROM access.private_group_member WHERE id = NEW.private_group_member_id;
    WHEN 'private_role_binding' THEN SELECT generation INTO current_generation
        FROM access.private_role_binding WHERE id = NEW.private_role_binding_id;
    WHEN 'policy_set_admission' THEN SELECT generation,
            active AND valid_until > frame.decided_at
        INTO current_generation, admission_live
        FROM access.policy_set_admission WHERE id = NEW.set_admission_id;
    ELSE SELECT generation INTO current_generation
        FROM access.interaction_block WHERE id = NEW.interaction_block_id;
    END CASE;
    IF current_generation IS DISTINCT FROM NEW.object_generation
        OR (NEW.kind = 'policy_set_admission'
            AND admission_live IS DISTINCT FROM (NEW.observed = 'present')) THEN
        RAISE EXCEPTION 'decision input differs from the frame snapshot'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER decision_snapshot_input_frame BEFORE INSERT
    ON access.decision_snapshot_input FOR EACH ROW
    EXECUTE FUNCTION access.check_decision_snapshot_input();

CREATE FUNCTION access.retain_unexpired_decision_input() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM access.decision_snapshot
        WHERE id = OLD.decision_id AND expires_at > clock_timestamp()) THEN
        RAISE EXCEPTION 'decision snapshot input is immutable until it expires'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER decision_snapshot_input_immutable BEFORE UPDATE OR DELETE
    ON access.decision_snapshot_input FOR EACH ROW
    EXECUTE FUNCTION access.retain_unexpired_decision_input();
