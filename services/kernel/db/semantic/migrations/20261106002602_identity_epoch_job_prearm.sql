-- migrate:up
-- Pre-arm added phase and cancellation locators after job immutability allowed only `state`.
-- Admission and cancellation write those columns on the original job; intent and receipts stay fixed.
CREATE OR REPLACE FUNCTION semantic.protect_identity_epoch_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND semantic.erasure_mutation_allowed('identity_epoch_job',OLD.partition_no*16,OLD.erasure_key)
   AND NEW.receipt='{"kind":"erased"}'::jsonb AND NEW.receipt_key='erased:'||OLD.job_id::text
   AND NEW.intent=(OLD.intent-'verificationReceipt')
   AND (to_jsonb(NEW)-ARRAY['intent','receipt','receipt_key'])=(to_jsonb(OLD)-ARRAY['intent','receipt','receipt_key']) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','prearm_phase','prearm_transaction_id','cancellation_transaction_id'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','prearm_phase','prearm_transaction_id','cancellation_transaction_id'])
    OR OLD.state='published' THEN
  RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.protect_identity_epoch_job() RETURNS trigger LANGUAGE plpgsql AS $$
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
