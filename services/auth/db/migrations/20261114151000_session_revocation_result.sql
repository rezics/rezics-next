-- migrate:up
-- Reuse the native effect owner and its existing erasure custody. Historical
-- authorization/session state is deliberately not backfilled into completion.
ALTER TABLE public.auth_effect_receipt
  ADD COLUMN session_revocation_binding jsonb,
  ADD COLUMN session_revocation_completed_at timestamp with time zone,
  ADD CONSTRAINT auth_session_revocation_result CHECK ((
    (session_revocation_binding IS NULL AND session_revocation_completed_at IS NULL) OR
    (session_revocation_binding IS NOT NULL AND session_revocation_completed_at IS NOT NULL
      AND jsonb_typeof(session_revocation_binding)='object'
      AND octet_length(session_revocation_binding::text)<=4096
      AND purpose='session-revocation' AND operation_key IS NULL
      AND minimum_authn_epoch>0
      AND session_revocation_binding->>'accountId'=account_id
      AND session_revocation_binding->>'minimumAuthnEpoch'=minimum_authn_epoch::text
      AND receipt_id='session-revocation:'||(session_revocation_binding->>'continuationId')
      AND session_revocation_binding->>'continuationDigest' ~ '^[0-9a-f]{64}$'
      AND session_revocation_binding->>'operationDigest' ~ '^[0-9a-f]{64}$'
      AND session_revocation_binding->>'stepDigest' ~ '^[0-9a-f]{64}$'
      AND session_revocation_binding->>'commandKeyPrefix' ~ '^wf:[0-9a-f]{64}$'
      AND session_revocation_binding->>'stepKey'=(session_revocation_binding->>'commandKeyPrefix')||':revoke-auth-sessions'
      AND session_revocation_binding ?& ARRAY['operationKey','barrierReceiptId','barrierTransactionId','authorizationReceiptId'])
  ) IS TRUE);

CREATE FUNCTION public.auth_session_revocation_result_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.session_revocation_binding IS NOT NULL OR NEW.session_revocation_binding IS NOT NULL THEN
    IF OLD.session_revocation_binding IS NULL OR
       ROW(NEW.receipt_id,NEW.account_id,NEW.purpose,NEW.minimum_authn_epoch) IS DISTINCT FROM
       ROW(OLD.receipt_id,OLD.account_id,OLD.purpose,OLD.minimum_authn_epoch) OR
       (NEW.session_revocation_binding IS NOT NULL AND
         (NEW.session_revocation_binding IS DISTINCT FROM OLD.session_revocation_binding OR
          NEW.session_revocation_completed_at IS DISTINCT FROM OLD.session_revocation_completed_at)) THEN
      RAISE EXCEPTION 'Session revocation result is immutable' USING ERRCODE='55000';
    END IF;
  END IF;
  -- Native minimization may clear both fields. It cannot later restore an ACK.
  RETURN NEW;
END $$;

CREATE TRIGGER auth_session_revocation_result_immutable
BEFORE UPDATE ON public.auth_effect_receipt
FOR EACH ROW EXECUTE FUNCTION public.auth_session_revocation_result_immutable();
