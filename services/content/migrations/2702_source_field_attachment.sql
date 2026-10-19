-- Opt-in verified attachments extend the existing support/withdrawal owner.
-- Legacy mappings, intents and receipts retain their original constraints.
ALTER TABLE source.field_support DROP CONSTRAINT field_support_slot_check;
ALTER TABLE source.field_support ADD CONSTRAINT field_support_slot_check CHECK (
  (slot ~ '^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}#[A-Za-z0-9:_.-]{1,100}$'
    OR slot ~ '^component-property-v1#https?://[^[:space:]]{1,512}$')
  AND slot <> 'work-metadata-v1#title:en' AND slot !~ '^work-author-credit-v1#');

ALTER TABLE source.field_support_step
  ADD COLUMN retained_binding_id uuid REFERENCES source.retained_record_binding(id),
  ADD COLUMN retained_admission jsonb,
  ADD COLUMN native_acknowledgement jsonb,
  ADD CONSTRAINT retained_field_admission_complete CHECK (
    (retained_binding_id IS NULL AND retained_admission IS NULL AND native_acknowledgement IS NULL)
    OR (retained_binding_id IS NOT NULL AND retained_admission IS NOT NULL AND native_acknowledgement IS NOT NULL AND action='attach'
      AND jsonb_typeof(retained_admission)='object'
      AND retained_admission ?& ARRAY['profile','sourceRecord','conversion','evidence','correspondence','native','headGuarantee']
      AND retained_admission->>'profile'='source-field-support-admission-v1'
      AND jsonb_typeof(native_acknowledgement)='object'
      AND native_acknowledgement ?& ARRAY['receipt','admissionId','dataEpoch','sequence','scope','action','component','revision']
      AND native_acknowledgement->>'revision'=expected_head));
ALTER TABLE source.field_support_step
  DROP CONSTRAINT field_support_step_mapping_revision_grain_source_field_fkey;

ALTER TABLE source.field_support_outcome ADD COLUMN attachment_profile text
  CHECK (attachment_profile='source-field-support-attachment-v2');
ALTER TABLE source.field_support_outcome DROP CONSTRAINT field_support_outcome_check;
ALTER TABLE source.field_support_outcome ADD CONSTRAINT field_support_outcome_native_receipt CHECK (
  (attachment_profile IS NULL AND (outcome='attached')=(graph_receipt IS NULL))
  OR (attachment_profile IS NOT NULL AND attachment_profile='source-field-support-attachment-v2' AND outcome='attached'
    AND graph_receipt IS NOT NULL AND head_guarantee='verified-before-commit'));
DROP INDEX source.field_support_outcome_receipt_idx;
CREATE UNIQUE INDEX field_support_outcome_receipt_idx ON source.field_support_outcome(graph_receipt)
  WHERE graph_receipt IS NOT NULL AND attachment_profile IS NULL;
CREATE INDEX field_support_outcome_native_receipt_idx ON source.field_support_outcome(graph_receipt,step_id)
  WHERE attachment_profile='source-field-support-attachment-v2';

-- Source issues this settlement receipt only in the transaction that commits a
-- verified support outcome. It is distinct from the native command's receipt.
CREATE TABLE source.field_support_attachment (
  step_id uuid PRIMARY KEY REFERENCES source.field_support_outcome(step_id),
  principal_id uuid NOT NULL,
  receipt text NOT NULL UNIQUE CHECK (receipt ~ '^urn:rezics:receipt:[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object' AND request ? 'profile'
    AND request->>'profile'='source-field-support-attachment-v2'),
  certificate jsonb NOT NULL CHECK (jsonb_typeof(certificate)='object'
    AND certificate ?& ARRAY['profile','receipt','requestDigest','nativeReceipt']
    AND certificate->>'profile'='source-field-attachment-certificate-v1'
    AND certificate->>'receipt'=receipt AND certificate->>'requestDigest'=request_digest),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER source_field_support_attachment_immutable BEFORE UPDATE OR DELETE ON source.field_support_attachment
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
CREATE FUNCTION source.check_field_support_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM source.field_support_step st JOIN source.field_support_outcome o ON o.step_id=st.id
    WHERE st.id=NEW.step_id AND st.principal_id=NEW.principal_id AND st.request_digest=NEW.request_digest
      AND st.retained_binding_id IS NOT NULL AND o.attachment_profile='source-field-support-attachment-v2'
      AND NEW.certificate->>'nativeReceipt'=o.graph_receipt
      AND st.native_acknowledgement->>'receipt'=o.graph_receipt
      AND st.retained_admission->'native'=NEW.request->'native'
      AND st.retained_admission->'evidence'=NEW.request->'evidence'
      AND NEW.request->>'target'=(SELECT target FROM source.field_support WHERE id=st.support_id)
      AND NEW.request->>'expectedHead'=st.expected_head
      AND NEW.request->>'actingSubject'=st.acting_subject
      AND NEW.request->>'sourceField'=st.source_field
      AND NEW.request->>'grain'=st.grain) THEN
    RAISE EXCEPTION 'attachment certificate differs from verified support'
      USING ERRCODE='23514',CONSTRAINT='field_attachment_certificate';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_field_support_attachment_check BEFORE INSERT ON source.field_support_attachment
  FOR EACH ROW EXECUTE FUNCTION source.check_field_support_attachment();

CREATE FUNCTION source.check_retained_field_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE step source.field_support_step;
BEGIN
  SELECT * INTO step FROM source.field_support_step WHERE id=NEW.step_id;
  IF (step.retained_binding_id IS NULL) IS DISTINCT FROM (NEW.attachment_profile IS NULL)
    OR (step.retained_binding_id IS NOT NULL AND (
      NEW.graph_receipt IS DISTINCT FROM step.native_acknowledgement->>'receipt'
      OR NEW.native_revision IS DISTINCT FROM step.native_acknowledgement->>'revision'
      OR NEW.admission_id::text IS DISTINCT FROM step.native_acknowledgement->>'admissionId'
      OR NEW.data_epoch::text IS DISTINCT FROM step.native_acknowledgement->>'dataEpoch'
      OR NEW.sequence::text IS DISTINCT FROM step.native_acknowledgement->>'sequence')) THEN
    RAISE EXCEPTION 'native acknowledgement differs from retained support outcome'
      USING ERRCODE='23514',CONSTRAINT='retained_field_native_outcome';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_retained_field_outcome BEFORE INSERT ON source.field_support_outcome
  FOR EACH ROW EXECUTE FUNCTION source.check_retained_field_outcome();

CREATE FUNCTION source.require_field_attachment_certificate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attachment_profile='source-field-support-attachment-v2'
    AND NOT EXISTS (SELECT 1 FROM source.field_support_attachment WHERE step_id=NEW.step_id) THEN
    RAISE EXCEPTION 'retained support settlement has no Source certificate'
      USING ERRCODE='23514',CONSTRAINT='field_attachment_certificate_required';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER source_retained_field_certificate AFTER INSERT ON source.field_support_outcome
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION source.require_field_attachment_certificate();

CREATE OR REPLACE FUNCTION source.reserve_field_support_step() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head source.field_support_head; support source.field_support;
BEGIN
  SELECT h.* INTO head FROM source.field_support_head h JOIN source.field_support s ON s.id = h.support_id
    WHERE h.support_id = NEW.support_id AND s.principal_id = NEW.principal_id FOR UPDATE OF h;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM source.field_support_withdrawal WHERE support_id = NEW.support_id) THEN
    RAISE EXCEPTION 'field support is unavailable or withdrawn'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_active';
  END IF;
  IF head.pending_step_id IS NOT NULL THEN
    RAISE EXCEPTION 'field support outcome needs reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_settled';
  END IF;
  IF NEW.ordinal <> head.step_count + 1 OR (NEW.action = 'return-control' AND head.settled_step_id IS NULL) THEN
    RAISE EXCEPTION 'field support step differs from its predecessor'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_sequence';
  END IF;
  SELECT * INTO support FROM source.field_support WHERE id = NEW.support_id;
  -- Only a field the mapping declares native/lossy for this exact slot, from this
  -- support's own source record, can support it. A redirect cannot re-route it.
  IF NEW.retained_binding_id IS NULL AND NOT EXISTS (SELECT 1 FROM source.conversion c JOIN source.observation o ON o.id = c.observation_id
      JOIN source.field_disposition d ON d.mapping_revision = c.mapping_revision
      WHERE c.id = NEW.conversion_id AND c.principal_id = NEW.principal_id
        AND c.mapping_revision = NEW.mapping_revision AND o.record_id = support.record_id
        AND d.grain = NEW.grain AND d.field_key = NEW.source_field
        AND d.disposition IN ('native', 'lossy') AND d.native_target = support.slot) THEN
    RAISE EXCEPTION 'field support source evidence differs'
      USING ERRCODE = '23514', CONSTRAINT = 'field_support_source';
  END IF;
  IF NEW.retained_binding_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM source.retained_record_binding b JOIN source.conversion c ON c.id=b.conversion_id
    WHERE b.id=NEW.retained_binding_id AND b.principal_id=NEW.principal_id
      AND b.record_id=support.record_id AND c.id=NEW.conversion_id AND c.mapping_revision=NEW.mapping_revision
      AND NEW.retained_admission->>'sourceRecord'='https://rezics.com/id/' || support.record_id
      AND NEW.retained_admission->>'conversion'='https://rezics.com/id/' || c.id
      AND NEW.retained_admission#>>'{evidence,binding}'='https://rezics.com/id/' || b.id
      AND NEW.retained_admission#>>'{evidence,recordDigest}'=b.request#>>'{retained,recordDigest}'
      AND NEW.retained_admission#>>'{evidence,mappingRevision}'=c.mapping_revision
      AND NEW.retained_admission#>>'{evidence,field,valueDigest}'=NEW.value_digest
      AND NEW.retained_admission#>>'{native,target}'=support.target
      AND NEW.retained_admission#>>'{native,revision}'=NEW.expected_head
      AND NEW.retained_admission#>>'{native,receipt}'=NEW.native_acknowledgement->>'receipt'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.field_inventory) f
        WHERE f->>'grain'=NEW.grain
          AND (CASE WHEN f->>'pointer' LIKE '/data/%' THEN substr(f->>'pointer',7)
            ELSE substr(f->>'pointer',2) END)=NEW.source_field
          AND f->>'pointer'=NEW.retained_admission#>>'{evidence,field,pointer}'
          AND f->>'disposition'='candidate')) THEN
    RAISE EXCEPTION 'retained field support differs from its verified record inventory'
      USING ERRCODE='23514',CONSTRAINT='field_support_source';
  END IF;
  RETURN NEW;
END $$;
