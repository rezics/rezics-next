-- An invitation offers one grant from an admitted issuer to a stable Agent IRI,
-- which may be cataloged but not yet admitted. It authenticates nobody: only a
-- principal holding a current 'access.invitation.accept' mandate for that exact
-- Agent can accept, and acceptance assigns the grant to the Agent, not to the
-- accepting Account. A profile edit or matching name creates no such mandate.
CREATE TABLE access.agent_invitation (
    id uuid PRIMARY KEY,
    issuer_subject text NOT NULL REFERENCES access.authority_subject(id),
    recipient_subject text NOT NULL
        CHECK (recipient_subject ~
            '^https://rezics\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    action text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
    grant_valid_until timestamptz NOT NULL,
    issuer_lifetime text NOT NULL
        CHECK (issuer_lifetime IN ('institutional', 'operator-dependent')),
    issued_by_principal uuid NOT NULL,
    issuer_representation_id uuid NOT NULL,
    issuer_representation_generation bigint NOT NULL
        CHECK (issuer_representation_generation >= 0),
    issuer_representation_action text NOT NULL,
    ceiling_grant_id uuid NOT NULL,
    ceiling_grant_generation bigint NOT NULL CHECK (ceiling_grant_generation >= 0),
    ceiling_scope_id text NOT NULL,
    ceiling_action text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, issuer_subject, recipient_subject, scope_id, action),
    FOREIGN KEY (issuer_representation_id, issued_by_principal, issuer_subject,
            issuer_representation_action)
        REFERENCES access.representation(id, principal_id, subject_id, action),
    FOREIGN KEY (ceiling_grant_id, issuer_subject, ceiling_scope_id, ceiling_action)
        REFERENCES access.permission_grant(id, recipient_subject, scope_id, action),
    CHECK (issuer_subject <> recipient_subject),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
    CHECK (grant_valid_until > expires_at)
);
CREATE INDEX agent_invitation_recipient ON access.agent_invitation (recipient_subject, id);
CREATE INDEX agent_invitation_issuer ON access.agent_invitation (issuer_subject, id);
CREATE INDEX agent_invitation_representation_fk ON access.agent_invitation
    (issuer_representation_id);
CREATE INDEX agent_invitation_ceiling_fk ON access.agent_invitation (ceiling_grant_id);
CREATE TRIGGER agent_invitation_immutable BEFORE UPDATE OR DELETE ON access.agent_invitation
    FOR EACH ROW EXECUTE FUNCTION access.reject_authority_control_mutation();

-- Acceptance pins the accepting mandate, the recipient's admitted generation
-- and the exact grant it activated; revocation is a separate terminal fact.
CREATE TABLE access.agent_invitation_acceptance (
    invitation_id uuid PRIMARY KEY,
    issuer_subject text NOT NULL,
    recipient_subject text NOT NULL,
    scope_id text NOT NULL,
    action text NOT NULL,
    accepted_by_principal uuid NOT NULL,
    acceptor_representation_id uuid NOT NULL,
    acceptor_representation_generation bigint NOT NULL
        CHECK (acceptor_representation_generation >= 0),
    acceptor_representation_action text NOT NULL
        CHECK (acceptor_representation_action = 'access.invitation.accept'),
    recipient_generation bigint NOT NULL CHECK (recipient_generation >= 0),
    grant_id uuid NOT NULL UNIQUE,
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (invitation_id, issuer_subject, recipient_subject, scope_id, action)
        REFERENCES access.agent_invitation(id, issuer_subject, recipient_subject, scope_id, action),
    FOREIGN KEY (acceptor_representation_id, accepted_by_principal, recipient_subject,
            acceptor_representation_action)
        REFERENCES access.representation(id, principal_id, subject_id, action),
    FOREIGN KEY (grant_id, issuer_subject, recipient_subject, scope_id, action)
        REFERENCES access.permission_grant(id, issuer_subject, recipient_subject, scope_id, action)
);
CREATE INDEX agent_invitation_acceptance_representation_fk
    ON access.agent_invitation_acceptance (acceptor_representation_id);

CREATE TABLE access.agent_invitation_revocation (
    invitation_id uuid PRIMARY KEY REFERENCES access.agent_invitation(id),
    revoked_by_principal uuid NOT NULL REFERENCES access.principal(id),
    revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_invitation_revocation_principal_fk
    ON access.agent_invitation_revocation (revoked_by_principal);

-- Both terminal writes lock the invitation row, so acceptance and revocation
-- cannot both commit. Acceptance happens before expiry with a current admitted
-- recipient and acceptor mandate; an operator-dependent invitation also needs
-- its issuing mandate unchanged. The activated grant carries this lineage.
CREATE FUNCTION access.check_agent_invitation_outcome() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE invitation record;
BEGIN
    SELECT * INTO invitation FROM access.agent_invitation WHERE id = NEW.invitation_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM access.agent_invitation_acceptance
            WHERE invitation_id = NEW.invitation_id)
        OR EXISTS (SELECT 1 FROM access.agent_invitation_revocation
            WHERE invitation_id = NEW.invitation_id) THEN
        RAISE EXCEPTION 'invitation already has an outcome' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'agent_invitation_revocation' THEN RETURN NEW; END IF;
    IF clock_timestamp() >= invitation.expires_at THEN
        RAISE EXCEPTION 'invitation expired' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM access.authority_subject
        WHERE id = invitation.recipient_subject AND active
            AND generation = NEW.recipient_generation;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'invitation recipient is not admitted' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM access.representation r JOIN access.principal p ON p.id = r.principal_id
        WHERE r.id = NEW.acceptor_representation_id AND r.active AND p.active
            AND r.generation = NEW.acceptor_representation_generation
            AND r.valid_until > clock_timestamp();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'invitation acceptor mandate is stale' USING ERRCODE = '23514';
    END IF;
    IF invitation.issuer_lifetime = 'operator-dependent' THEN
        PERFORM 1 FROM access.representation
            WHERE id = invitation.issuer_representation_id AND active
                AND generation = invitation.issuer_representation_generation
                AND valid_until > clock_timestamp();
        IF NOT FOUND THEN
            RAISE EXCEPTION 'invitation issuing mandate ended' USING ERRCODE = '23514';
        END IF;
    END IF;
    PERFORM 1 FROM access.grant_lineage l JOIN access.permission_grant g ON g.id = l.grant_id
        WHERE l.grant_id = NEW.grant_id AND l.invitation_id = NEW.invitation_id
            AND l.lifetime = 'institutional' AND g.active
            AND g.valid_until <= invitation.grant_valid_until;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'invitation grant lacks its lineage' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER agent_invitation_acceptance_outcome BEFORE INSERT
    ON access.agent_invitation_acceptance FOR EACH ROW
    EXECUTE FUNCTION access.check_agent_invitation_outcome();
CREATE TRIGGER agent_invitation_revocation_outcome BEFORE INSERT
    ON access.agent_invitation_revocation FOR EACH ROW
    EXECUTE FUNCTION access.check_agent_invitation_outcome();
CREATE TRIGGER agent_invitation_acceptance_immutable BEFORE UPDATE OR DELETE
    ON access.agent_invitation_acceptance FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();
CREATE TRIGGER agent_invitation_revocation_immutable BEFORE UPDATE OR DELETE
    ON access.agent_invitation_revocation FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();

ALTER TABLE access.grant_lineage ADD CONSTRAINT grant_lineage_invitation_fk
    FOREIGN KEY (invitation_id) REFERENCES access.agent_invitation(id);

-- The activated grant keeps the invitation's issuer, operator and offer. An
-- institutional invitation rechecks the issuer's current ceiling; an
-- operator-dependent one also keeps the original mandate and ceiling.
CREATE FUNCTION access.check_invitation_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE invitation record;
BEGIN
    SELECT * INTO invitation FROM access.agent_invitation WHERE id = NEW.invitation_id;
    IF NEW.lifetime <> 'institutional'
        OR (NEW.issuer_subject, NEW.recipient_subject, NEW.scope_id, NEW.action,
            NEW.assigned_by_principal, NEW.issuer_representation_id,
            NEW.issuer_representation_generation, NEW.issuer_representation_action,
            NEW.ceiling_scope_id, NEW.ceiling_action)
        IS DISTINCT FROM (invitation.issuer_subject, invitation.recipient_subject,
            invitation.scope_id, invitation.action, invitation.issued_by_principal,
            invitation.issuer_representation_id, invitation.issuer_representation_generation,
            invitation.issuer_representation_action, invitation.ceiling_scope_id,
            invitation.ceiling_action)
        OR (invitation.issuer_lifetime = 'operator-dependent'
            AND (NEW.ceiling_grant_id, NEW.ceiling_grant_generation)
                IS DISTINCT FROM
                (invitation.ceiling_grant_id, invitation.ceiling_grant_generation)) THEN
        RAISE EXCEPTION 'invitation grant differs from its offer' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER grant_lineage_invitation_basis BEFORE INSERT ON access.grant_lineage
    FOR EACH ROW WHEN (NEW.invitation_id IS NOT NULL)
    EXECUTE FUNCTION access.check_invitation_lineage();
