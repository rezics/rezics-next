-- One immutable private proof per dispatchable organization publication decision.
-- The admission and proof are committed together while the participation gate,
-- episode and selected manager authority remain locked.
CREATE TABLE access.organization_publication_moderation (
    admission_id uuid PRIMARY KEY REFERENCES access.admission(id),
    realm text NOT NULL REFERENCES access.org_realm_policy(realm),
    organization_subject text NOT NULL REFERENCES access.org_participation_subject(subject),
    participation_id uuid NOT NULL,
    participation_generation bigint NOT NULL,
    proposal_id uuid NOT NULL REFERENCES access.org_realm_proposal(id),
    publisher_admission_id uuid NOT NULL REFERENCES access.admission(id),
    target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
    authority_proof jsonb NOT NULL CHECK (jsonb_typeof(authority_proof) = 'object'),
    proof_digest text NOT NULL CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (target @> jsonb_build_object('realm', realm, 'organizationSubject', organization_subject,
        'participationId', participation_id::text, 'participationGeneration', participation_generation::text,
        'proposalId', proposal_id::text)),
    CHECK (authority_proof->'publisher' @> jsonb_build_object('admissionId', publisher_admission_id::text)),
    FOREIGN KEY (participation_id, participation_generation)
        REFERENCES access.org_realm_history(participation_id, generation)
);
CREATE TRIGGER organization_publication_moderation_immutable BEFORE UPDATE OR DELETE
    ON access.organization_publication_moderation FOR EACH ROW
    EXECUTE FUNCTION access.reject_membership_record_mutation();
CREATE INDEX organization_moderation_realm_fk ON access.organization_publication_moderation (realm);
CREATE INDEX organization_moderation_org_fk ON access.organization_publication_moderation (organization_subject);
CREATE INDEX organization_moderation_episode_fk ON access.organization_publication_moderation
    (participation_id, participation_generation);
CREATE INDEX organization_moderation_proposal_fk ON access.organization_publication_moderation (proposal_id);
CREATE INDEX organization_moderation_publisher_fk ON access.organization_publication_moderation (publisher_admission_id);
CREATE INDEX organization_moderation_grant ON access.permission_grant
    (recipient_subject, scope_id, valid_until, id)
    WHERE active AND membership_id IS NULL AND action = 'publication.reject.organization';

-- Even a writer bug cannot commit a dispatchable admission without its exact
-- proof. Deferral permits inserting both rows in the same owner transaction.
CREATE FUNCTION access.require_organization_moderation_proof() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state NOT IN ('claimed', 'sealed') OR NOT EXISTS (
        SELECT 1 FROM access.organization_publication_moderation m
        WHERE m.admission_id = NEW.id
          AND m.target->>'actingSubject' = NEW.acting_subject
          AND m.authority_proof->>'principalId' = NEW.principal_id::text
          AND NEW.scope_id = 'publication:reject:' || m.realm
    ) THEN
        RAISE EXCEPTION 'organization moderation admission requires exact atomic proof' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER organization_moderation_admission_bound
    AFTER INSERT OR UPDATE ON access.admission DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.action = 'publication.reject.organization')
    EXECUTE FUNCTION access.require_organization_moderation_proof();
