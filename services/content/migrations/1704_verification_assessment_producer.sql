-- The graph assessment receipt precedes its Content effects. Retain the original
-- bounded intent so recovery can finish that tail without dispatching graph work.
CREATE TABLE verification.assessment_producer_gate (
  singleton boolean PRIMARY KEY CHECK (singleton),
  mode text NOT NULL DEFAULT 'ordinary' CHECK (mode IN ('ordinary', 'maintenance')),
  job text CHECK (job ~ '^[A-Za-z0-9:_-]{1,128}$'),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  restore_epoch bigint NOT NULL CHECK (restore_epoch >= 0),
  CHECK ((mode = 'ordinary' AND job IS NULL)
    OR (mode = 'maintenance' AND job IS NOT NULL AND generation > 0))
);
INSERT INTO verification.assessment_producer_gate (singleton, restore_epoch)
  SELECT true, version FROM reading_position.generation WHERE singleton;

CREATE TABLE verification.assessment_producer (
  admission_id uuid PRIMARY KEY,
  request_digest verification.sha256 NOT NULL,
  principal_id uuid NOT NULL,
  acting_subject verification.rezics_id NOT NULL,
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 300),
  authority_epoch text NOT NULL CHECK (length(authority_epoch) BETWEEN 1 AND 300),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  claim verification.rezics_id NOT NULL,
  claim_revision verification.rezics_id NOT NULL,
  -- The existing assessment digest retains JavaScript property order. Preserve
  -- its original serialization; JSONB alone would erase that digest input.
  intent_json text NOT NULL CHECK (jsonb_typeof(intent_json::jsonb) = 'object'
    AND octet_length(intent_json) <= 16384
    AND intent_json::jsonb ?& ARRAY['claimRevision', 'evidenceSetRevision', 'sourceAssessments',
      'method', 'judgment', 'evaluationContext', 'adoptedRevision', 'scorePerMillion', 'calibration',
      'limitations', 'expectedSummary', 'resolvesChallenges', 'actingSubject']
    AND intent_json::jsonb - ARRAY['claimRevision', 'evidenceSetRevision', 'sourceAssessments',
      'method', 'judgment', 'evaluationContext', 'adoptedRevision', 'scorePerMillion', 'calibration',
      'evaluationReference', 'limitations', 'expectedSummary', 'resolvesChallenges', 'actingSubject'] = '{}'::jsonb
    AND jsonb_typeof(intent_json::jsonb->'sourceAssessments') = 'array'
    AND jsonb_array_length(intent_json::jsonb->'sourceAssessments') <= 32
    AND jsonb_typeof(intent_json::jsonb->'resolvesChallenges') = 'array'
    AND jsonb_array_length(intent_json::jsonb->'resolvesChallenges') <= 8),
  stage_generation bigint NOT NULL CHECK (stage_generation >= 0),
  restore_epoch bigint NOT NULL CHECK (restore_epoch >= 0),
  terminal jsonb CHECK (jsonb_typeof(terminal) = 'object' AND octet_length(terminal::text) <= 4096
    AND terminal ?& ARRAY['status', 'receipt', 'assessment', 'activation']
    AND terminal - ARRAY['status', 'receipt', 'assessment', 'activation'] = '{}'::jsonb
    AND jsonb_typeof(terminal->'receipt') = 'string' AND jsonb_typeof(terminal->'activation') = 'object'
    AND terminal->>'status' IN ('activated', 'refused', 'no-activation', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  terminal_at timestamptz,
  CHECK (intent_json::jsonb->>'claimRevision' = claim_revision AND intent_json::jsonb->>'actingSubject' = acting_subject),
  CHECK ((terminal IS NULL) = (terminal_at IS NULL))
);
CREATE INDEX assessment_producer_pending ON verification.assessment_producer (admission_id)
  WHERE terminal IS NULL;

-- Only the one terminal append may update a producer. Its original request and
-- history remain exact even after the active summary has been superseded.
CREATE FUNCTION verification.seal_assessment_producer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable assessment producer intent' USING ERRCODE = '23514';
  END IF;
  IF OLD.terminal IS NOT NULL OR NEW.terminal IS NULL OR
    ROW(NEW.admission_id, NEW.request_digest, NEW.principal_id, NEW.acting_subject,
      NEW.scope, NEW.authority_epoch, NEW.idempotency_key,
      NEW.claim, NEW.claim_revision, NEW.intent_json, NEW.stage_generation, NEW.restore_epoch, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.admission_id, OLD.request_digest, OLD.principal_id, OLD.acting_subject,
      OLD.scope, OLD.authority_epoch, OLD.idempotency_key,
      OLD.claim, OLD.claim_revision, OLD.intent_json, OLD.stage_generation, OLD.restore_epoch, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable assessment producer intent or terminal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assessment_producer_immutable BEFORE UPDATE OR DELETE ON verification.assessment_producer
  FOR EACH ROW EXECUTE FUNCTION verification.seal_assessment_producer();
