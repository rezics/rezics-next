-- A bounded second support has its own immutable identity. The original unique
-- Work adoption and all v1 receipt rows stay unchanged.
CREATE TABLE source.native_work_support_attachment (
  id uuid PRIMARY KEY,
  binding_id uuid NOT NULL UNIQUE REFERENCES source.native_work_binding(id),
  proposal_id uuid NOT NULL UNIQUE REFERENCES source.native_work_proposal(id),
  record_id uuid NOT NULL REFERENCES source.record(id),
  principal_id uuid NOT NULL,
  work text NOT NULL UNIQUE CHECK (work ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  work_revision text NOT NULL CHECK (work_revision ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND title !~ '[[:cntrl:]]'),
  acting_subject text NOT NULL CHECK (acting_subject ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  authority_proof jsonb NOT NULL CHECK (jsonb_typeof(authority_proof) = 'object'
    AND authority_proof->>'principalId' = principal_id::text
    AND authority_proof->>'actingSubject' = acting_subject
    AND authority_proof->>'scope' = 'work:edit:' || work
    AND authority_proof->>'action' = 'work.edit'
    AND authority_proof ?& ARRAY['principalId','actingSubject','scope','action',
      'principalEpoch','subjectGeneration','authorityEpoch','recoveryGeneration',
      'representationId','representationGeneration','grantId','grantGeneration','validUntil']),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX native_work_support_attachment_principal_idx
  ON source.native_work_support_attachment (principal_id, id);
CREATE TRIGGER source_native_work_support_attachment_immutable
  BEFORE UPDATE OR DELETE ON source.native_work_support_attachment
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE TABLE source.native_work_attachment_withdrawal (
  id uuid PRIMARY KEY,
  attachment_id uuid NOT NULL UNIQUE REFERENCES source.native_work_support_attachment(id),
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500
    AND reason !~ '[[:cntrl:]]' AND reason = btrim(reason)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE TRIGGER source_native_work_attachment_withdrawal_immutable
  BEFORE UPDATE OR DELETE ON source.native_work_attachment_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE FUNCTION source.check_native_work_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_record uuid;
BEGIN
  -- Same lock as v1 intent/application/withdrawal. Never infer that an uncertain
  -- native application failed, and never borrow another principal's binding.
  SELECT p.record_id INTO original_record FROM source.native_work_binding b
    JOIN source.native_work_proposal p ON p.id = b.proposal_id
    JOIN source.native_work_support_head h ON h.binding_id = b.id
    WHERE b.id = NEW.binding_id AND b.work = NEW.work
      AND b.principal_id = NEW.principal_id AND p.principal_id = NEW.principal_id
    FOR UPDATE OF h;
  IF NOT FOUND OR original_record = NEW.record_id THEN
    RAISE EXCEPTION 'attachment needs a distinct source and the same owning Work'
      USING ERRCODE = '23514', CONSTRAINT = 'native_work_attachment_binding';
  END IF;
  IF EXISTS (SELECT 1 FROM source.native_work_title_pending WHERE binding_id = NEW.binding_id) THEN
    RAISE EXCEPTION 'source title intent needs reconciliation before attachment'
      USING ERRCODE = '23514', CONSTRAINT = 'native_work_attachment_pending';
  END IF;
  PERFORM 1 FROM source.native_work_proposal WHERE id = NEW.proposal_id
    AND principal_id = NEW.principal_id AND record_id = NEW.record_id
    AND candidate_title = NEW.title FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM source.native_work_adoption_intent
      WHERE proposal_id = NEW.proposal_id) THEN
    RAISE EXCEPTION 'proposal is unavailable or reserved for adoption'
      USING ERRCODE = '23514', CONSTRAINT = 'native_work_attachment_proposal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_native_work_support_attach BEFORE INSERT ON source.native_work_support_attachment
  FOR EACH ROW EXECUTE FUNCTION source.check_native_work_attachment();

CREATE FUNCTION source.check_native_work_adoption_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM source.native_work_proposal WHERE id = NEW.proposal_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM source.native_work_support_attachment WHERE proposal_id = NEW.proposal_id) THEN
    RAISE EXCEPTION 'proposal is already attached to a Work'
      USING ERRCODE = '23514', CONSTRAINT = 'native_work_attachment_proposal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_native_work_adoption_attachment BEFORE INSERT ON source.native_work_adoption_intent
  FOR EACH ROW EXECUTE FUNCTION source.check_native_work_adoption_attachment();

CREATE FUNCTION source.withdraw_native_work_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM source.native_work_support_attachment
    WHERE id = NEW.attachment_id AND principal_id = NEW.principal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attachment belongs to another principal'
      USING ERRCODE = '23514', CONSTRAINT = 'native_work_attachment_owner';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_native_work_attachment_withdraw BEFORE INSERT ON source.native_work_attachment_withdrawal
  FOR EACH ROW EXECUTE FUNCTION source.withdraw_native_work_attachment();
