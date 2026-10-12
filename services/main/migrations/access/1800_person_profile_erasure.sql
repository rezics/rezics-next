-- Retain provisioning identity and graph receipt positions; only the identifying
-- profile copy can disappear under the exact Account-child erasure proof.
ALTER TABLE access.agent_provision
  ALTER COLUMN display_name DROP NOT NULL,
  ADD COLUMN profile_erasure_id uuid,
  ADD COLUMN profile_erasure_epoch bigint,
  ADD COLUMN account_erasure_id uuid,
  ADD COLUMN deletion_intent_id uuid REFERENCES access.outbox(id),
  ADD COLUMN deletion_enforcement_epoch bigint,
  ADD COLUMN subject_epoch bigint,
  ADD CONSTRAINT agent_provision_profile_erasure CHECK (
    (display_name IS NOT NULL AND profile_erasure_id IS NULL
      AND profile_erasure_epoch IS NULL AND account_erasure_id IS NULL
      AND deletion_intent_id IS NULL AND deletion_enforcement_epoch IS NULL AND subject_epoch IS NULL)
    OR (display_name IS NULL AND agent_kind = 'person' AND state = 'active'
      AND profile_erasure_id IS NOT NULL AND profile_erasure_epoch > 0
      AND profile_erasure_epoch IS NOT NULL AND account_erasure_id IS NOT NULL
      AND profile_erasure_id <> account_erasure_id AND deletion_intent_id IS NOT NULL
      AND deletion_enforcement_epoch IS NOT NULL AND deletion_enforcement_epoch > 0
      AND subject_epoch IS NOT NULL AND subject_epoch > 0)
  );

CREATE INDEX agent_provision_retained_person
  ON access.agent_provision (principal_id, agent_id)
  WHERE agent_kind = 'person' AND state = 'active';

-- The journal is in a separate database. The owner verifies its immutable
-- parent/child and sealed targets before installing a transaction-local context.
-- Local state still has to match while its owner locks are held.
CREATE FUNCTION access.person_profile_erasure_qualified(person text, principal uuid,
  intent uuid, enforcement bigint, subject_epoch bigint) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM access.agent_provision a
    JOIN access.principal p ON p.id = a.principal_id
    JOIN access.authority_subject s ON s.id = a.agent_id
    JOIN access.outbox o ON o.principal_id = p.id AND o.kind = 'account.deletion_fenced'
    WHERE a.agent_id = $1 AND a.principal_id = $2
      AND a.agent_kind = 'person' AND a.state = 'active'
      AND NOT p.active AND NOT s.active AND s.kind = 'agent'
      AND p.enforcement_epoch = $4 AND s.generation = $5
      AND o.id = $3 AND o.authority_epoch = $4)
$$;

-- Both SQL profile-copy owners consume the same transaction-local proof that
-- the Access owner installs only after checking the retained relay journal.
CREATE FUNCTION access.assert_person_profile_erasure(person text) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE context jsonb;
BEGIN
  context := nullif(current_setting('rezics.person_profile_erasure', true), '')::jsonb;
  IF context IS NULL OR context->>'person' IS DISTINCT FROM person
    OR NOT EXISTS (SELECT 1 FROM access.agent_provision a
      WHERE a.id::text = context->>'provisionId' AND a.agent_id = person
        AND a.principal_id::text = context->>'principalId'
        AND a.agent_kind = 'person' AND a.state = 'active'
        AND (a.profile_erasure_id IS NULL OR (
          a.profile_erasure_id::text = context->>'erasureId'
          AND a.profile_erasure_epoch::text = context->>'erasureEpoch'
          AND a.account_erasure_id::text = context->>'accountErasureId'
          AND a.deletion_intent_id::text = context->>'deletionIntentId'
          AND a.deletion_enforcement_epoch::text = context->>'deletionEnforcementEpoch'
          AND a.subject_epoch::text = context->>'subjectEpoch')))
    OR NOT EXISTS (SELECT 1 FROM access.recovery_fence WHERE id = true AND open)
    OR NOT access.person_profile_erasure_qualified(person,
      (context->>'principalId')::uuid, (context->>'deletionIntentId')::uuid,
      (context->>'deletionEnforcementEpoch')::bigint, (context->>'subjectEpoch')::bigint)
    OR EXISTS (SELECT 1 FROM access.governance_preservation_hold h
      JOIN access.principal p ON p.id::text = context->>'principalId'
      WHERE h.released_at IS NULL AND (h.target_resource = person OR h.author_subject = person
        OR (h.account_issuer = p.account_issuer AND h.account_subject = p.account_subject))) THEN
    RAISE EXCEPTION 'Person profile sanitation requires exact ended Account authority' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION access.agent_provision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE context jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable Agent provision identity or terminal outcome' USING ERRCODE = '23514';
  END IF;
  IF OLD.profile_erasure_id IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'erased Agent provision is terminal' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.profile_erasure_id IS NOT NULL THEN
    PERFORM access.assert_person_profile_erasure(NEW.agent_id);
    context := nullif(current_setting('rezics.person_profile_erasure', true), '')::jsonb;
    IF context IS NULL OR NOT (context @> jsonb_build_object(
        'erasureId', NEW.profile_erasure_id::text,
        'erasureEpoch', NEW.profile_erasure_epoch::text,
        'accountErasureId', NEW.account_erasure_id::text,
        'principalId', NEW.principal_id::text, 'person', NEW.agent_id,
        'provisionId', NEW.id::text, 'deletionIntentId', NEW.deletion_intent_id::text,
        'deletionEnforcementEpoch', NEW.deletion_enforcement_epoch::text,
        'subjectEpoch', NEW.subject_epoch::text))
      OR OLD.state <> 'active' OR OLD.agent_kind <> 'person'
      OR OLD.display_name IS NULL OR NEW.display_name IS NOT NULL
      OR (to_jsonb(OLD) - ARRAY['display_name','profile_erasure_id','profile_erasure_epoch',
        'account_erasure_id','deletion_intent_id','deletion_enforcement_epoch','subject_epoch','updated_at'])
        IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['display_name','profile_erasure_id','profile_erasure_epoch',
        'account_erasure_id','deletion_intent_id','deletion_enforcement_epoch','subject_epoch','updated_at'])
      OR NOT access.person_profile_erasure_qualified(NEW.agent_id, NEW.principal_id,
        NEW.deletion_intent_id, NEW.deletion_enforcement_epoch, NEW.subject_epoch) THEN
      RAISE EXCEPTION 'Person profile sanitation requires exact ended Account authority' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (OLD.id, OLD.principal_id, OLD.idempotency_key,
      OLD.request_digest, OLD.agent_id, OLD.agent_kind, OLD.display_name,
      OLD.principal_epoch, OLD.created_at) IS DISTINCT FROM
      (NEW.id, NEW.principal_id, NEW.idempotency_key,
      NEW.request_digest, NEW.agent_id, NEW.agent_kind, NEW.display_name,
      NEW.principal_epoch, NEW.created_at) OR OLD.state IN ('active', 'compensated') THEN
    RAISE EXCEPTION 'immutable Agent provision identity or terminal outcome' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.state = 'planned' AND NEW.state IN ('planned', 'graph_committed', 'compensating'))
    OR (OLD.state = 'graph_committed' AND NEW.state IN ('graph_committed', 'active', 'compensating'))
    OR (OLD.state = 'compensating' AND NEW.state IN ('compensating', 'compensated'))) THEN
    RAISE EXCEPTION 'invalid Agent provision transition' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
