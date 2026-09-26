-- Grant lineage records, at creation, the lifetime contract a grant follows and
-- the exact authority that issued it: the operator's mandate for the issuer
-- subject and the issuer's covering ceiling grant. An institutional grant
-- survives its operator's departure and pins its own ceiling; a dependent grant
-- redelegates its upstream grant and is fenced with it. A grant without lineage
-- keeps the earlier institutional or membership-episode semantics.
CREATE TABLE access.grant_lineage (
    grant_id uuid PRIMARY KEY,
    issuer_subject text NOT NULL,
    recipient_subject text NOT NULL,
    scope_id text NOT NULL,
    action text NOT NULL,
    lifetime text NOT NULL CHECK (lifetime IN ('institutional', 'dependent')),
    assigned_by_principal uuid NOT NULL,
    issuer_representation_id uuid NOT NULL,
    issuer_representation_generation bigint NOT NULL
        CHECK (issuer_representation_generation >= 0),
    issuer_representation_action text NOT NULL,
    ceiling_grant_id uuid NOT NULL,
    ceiling_grant_generation bigint NOT NULL CHECK (ceiling_grant_generation >= 0),
    ceiling_scope_id text NOT NULL,
    ceiling_action text NOT NULL,
    upstream_grant_id uuid,
    upstream_generation bigint CHECK (upstream_generation >= 0),
    root_grant_id uuid NOT NULL,
    depth smallint NOT NULL CHECK (depth BETWEEN 0 AND 8),
    redelegation_depth smallint NOT NULL CHECK (redelegation_depth BETWEEN 0 AND 8),
    representative_policy_id uuid,
    invitation_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (grant_id, issuer_subject, recipient_subject, scope_id, action)
        REFERENCES access.permission_grant(id, issuer_subject, recipient_subject, scope_id, action),
    FOREIGN KEY (issuer_representation_id, assigned_by_principal, issuer_subject,
            issuer_representation_action)
        REFERENCES access.representation(id, principal_id, subject_id, action),
    FOREIGN KEY (ceiling_grant_id, issuer_subject, ceiling_scope_id, ceiling_action)
        REFERENCES access.permission_grant(id, recipient_subject, scope_id, action),
    FOREIGN KEY (upstream_grant_id, issuer_subject, scope_id, action)
        REFERENCES access.permission_grant(id, recipient_subject, scope_id, action),
    FOREIGN KEY (root_grant_id) REFERENCES access.grant_lineage(grant_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (representative_policy_id, issuer_subject)
        REFERENCES access.representative_policy(id, approval_subject),
    FOREIGN KEY (representative_policy_id, recipient_subject)
        REFERENCES access.representative_policy(id, institution_subject),
    CHECK ((lifetime = 'dependent') = (upstream_grant_id IS NOT NULL)),
    CHECK ((upstream_grant_id IS NULL) = (upstream_generation IS NULL)),
    CHECK ((lifetime = 'institutional') = (depth = 0)),
    CHECK ((lifetime = 'institutional') = (root_grant_id = grant_id)),
    -- A redelegation's ceiling is exactly the upstream grant it depends on.
    CHECK (lifetime = 'institutional' OR (ceiling_grant_id = upstream_grant_id
        AND ceiling_grant_generation = upstream_generation)),
    CHECK (lifetime = 'institutional' OR representative_policy_id IS NULL),
    CHECK (grant_id <> ceiling_grant_id)
);
CREATE INDEX grant_lineage_upstream ON access.grant_lineage (upstream_grant_id, grant_id)
    WHERE upstream_grant_id IS NOT NULL;
CREATE INDEX grant_lineage_root ON access.grant_lineage (root_grant_id, grant_id);
CREATE INDEX grant_lineage_ceiling_fk ON access.grant_lineage (ceiling_grant_id);
CREATE INDEX grant_lineage_representation_fk ON access.grant_lineage (issuer_representation_id);
CREATE INDEX grant_lineage_policy_fk ON access.grant_lineage (representative_policy_id)
    WHERE representative_policy_id IS NOT NULL;
CREATE INDEX grant_lineage_invitation_fk ON access.grant_lineage (invitation_id)
    WHERE invitation_id IS NOT NULL;

-- Issuance proof is current at creation. A dependent grant needs a live,
-- redelegable upstream grant covering its validity; one root has at most 256
-- live descendants so a revocation cascade stays bounded.
CREATE FUNCTION access.check_grant_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE upstream record; descendants integer;
BEGIN
    PERFORM 1 FROM access.permission_grant WHERE id = NEW.grant_id AND active FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'grant lineage needs an active grant' USING ERRCODE = '23514';
    END IF;
    -- An invitation-activated grant rechecks its issuer under the invitation's
    -- declared lifetime instead (055).
    IF NEW.invitation_id IS NULL THEN
        PERFORM 1 FROM access.representation
            WHERE id = NEW.issuer_representation_id AND active
                AND generation = NEW.issuer_representation_generation FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'grant issuer mandate is stale' USING ERRCODE = '23514';
        END IF;
    END IF;
    PERFORM 1 FROM access.permission_grant c, access.permission_grant g
        WHERE c.id = NEW.ceiling_grant_id AND c.active
            AND c.generation = NEW.ceiling_grant_generation
            AND g.id = NEW.grant_id AND c.valid_until >= g.valid_until
        FOR SHARE OF c;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'grant ceiling is stale or shorter' USING ERRCODE = '23514';
    END IF;
    IF NEW.lifetime = 'institutional' THEN RETURN NEW; END IF;
    SELECT l.depth, l.root_grant_id, l.redelegation_depth INTO upstream
        FROM access.grant_lineage l WHERE l.grant_id = NEW.upstream_grant_id;
    IF NOT FOUND OR upstream.redelegation_depth < 1
        OR NEW.redelegation_depth > upstream.redelegation_depth - 1
        OR NEW.depth <> upstream.depth + 1 OR NEW.root_grant_id <> upstream.root_grant_id THEN
        RAISE EXCEPTION 'upstream grant cannot be redelegated here' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO descendants FROM (SELECT 1 FROM access.grant_lineage l
        JOIN access.permission_grant g ON g.id = l.grant_id
        WHERE l.root_grant_id = NEW.root_grant_id AND l.grant_id <> NEW.grant_id
            AND l.lifetime = 'dependent' AND g.active LIMIT 256) live;
    IF descendants >= 256 THEN
        RAISE EXCEPTION 'dependent grant fan-out limit' USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER grant_lineage_issuance BEFORE INSERT ON access.grant_lineage
    FOR EACH ROW EXECUTE FUNCTION access.check_grant_lineage();
CREATE TRIGGER grant_lineage_immutable BEFORE UPDATE OR DELETE ON access.grant_lineage
    FOR EACH ROW EXECUTE FUNCTION access.reject_authority_control_mutation();

-- A grant with lineage keeps its identity and cannot be revived; revoking it
-- revokes live dependents in the same transaction, recursively to depth 8.
CREATE FUNCTION access.keep_grant_lineage_episode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM access.grant_lineage WHERE grant_id = OLD.id)
        AND ((NEW.id, NEW.issuer_subject, NEW.recipient_subject, NEW.scope_id, NEW.action,
                NEW.valid_until, NEW.assigned_by_principal)
            IS DISTINCT FROM (OLD.id, OLD.issuer_subject, OLD.recipient_subject, OLD.scope_id,
                OLD.action, OLD.valid_until, OLD.assigned_by_principal)
            OR (NOT OLD.active AND NEW.active)) THEN
        RAISE EXCEPTION 'grant lineage episode is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER permission_grant_lineage_episode BEFORE UPDATE ON access.permission_grant
    FOR EACH ROW EXECUTE FUNCTION access.keep_grant_lineage_episode();

CREATE FUNCTION access.revoke_dependent_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE access.permission_grant g SET active = false
    FROM access.grant_lineage l
    WHERE l.upstream_grant_id = NEW.id AND g.id = l.grant_id AND g.active;
    RETURN NULL;
END $$;
CREATE TRIGGER permission_grant_dependent_revocation AFTER UPDATE OF active
    ON access.permission_grant FOR EACH ROW
    WHEN (OLD.active AND NOT NEW.active)
    EXECUTE FUNCTION access.revoke_dependent_grants();
