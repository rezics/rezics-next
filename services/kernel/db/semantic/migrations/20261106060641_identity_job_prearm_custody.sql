-- migrate:up
-- Prearm phase, prearm transaction and cancellation custody advance on the identity job itself. Intent,
-- receipts and published jobs stay immutable; the trigger had been written before the prearm columns existed.
CREATE OR REPLACE FUNCTION semantic.protect_identity_epoch_job() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND semantic.erasure_mutation_allowed('identity_epoch_job',OLD.partition_no*16,OLD.erasure_key)
   AND NEW.receipt='{"kind":"erased"}'::jsonb AND NEW.receipt_key='erased:'||OLD.job_id::text
   AND NEW.intent=(OLD.intent-'verificationReceipt')
   AND (to_jsonb(NEW)-ARRAY['intent','receipt','receipt_key'])=(to_jsonb(OLD)-ARRAY['intent','receipt','receipt_key']) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514'; END IF;
 -- Lifecycle state and prearm/cancellation custody advance in place; intent, receipts and published jobs never change.
 IF OLD.state='published'
   OR (to_jsonb(NEW)-ARRAY['state','prearm_phase','prearm_transaction_id','cancellation_transaction_id'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','prearm_phase','prearm_transaction_id','cancellation_transaction_id']) THEN
  RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.protect_identity_epoch_job() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND semantic.erasure_mutation_allowed('identity_epoch_job',OLD.partition_no*16,OLD.erasure_key)
   AND NEW.receipt='{"kind":"erased"}'::jsonb AND NEW.receipt_key='erased:'||OLD.job_id::text
   AND NEW.intent=(OLD.intent-'verificationReceipt')
   AND (to_jsonb(NEW)-ARRAY['intent','receipt','receipt_key'])=(to_jsonb(OLD)-ARRAY['intent','receipt','receipt_key']) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state='published' THEN
  RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
