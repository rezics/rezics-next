-- The pinned provider consumes a pending authorization code before it checks
-- the presenting client, redirect, resource and PKCE verifier. Account restores
-- the exact verification row after such a rejected exchange. A restored code
-- keeps the basis bound at its first issuance; it never rebinds to a later
-- client registration or consent generation. Only an identical code identity
-- reuses a retained basis; any other identifier collision still fails closed.
CREATE OR REPLACE FUNCTION public.rezics_bind_authorization_code()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payload jsonb;
  code_client text;
  code_user text;
  code_reference text;
  client_skip boolean;
  current_consent public."oauthConsent"%ROWTYPE;
BEGIN
  BEGIN
    payload := NEW.value::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;
  IF payload->>'type' IS DISTINCT FROM 'authorization_code' THEN RETURN NEW; END IF;
  code_client := payload#>>'{query,client_id}';
  code_user := payload->>'userId';
  code_reference := payload->>'referenceId';
  IF code_client IS NULL OR code_user IS NULL THEN
    RAISE EXCEPTION 'OAuth code identity unavailable' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rezics_oauth_code_basis b
    WHERE b.id = NEW.identifier AND b.client_id = code_client
      AND b.user_id = code_user AND b.reference_id IS NOT DISTINCT FROM code_reference
      AND b.expires_at = NEW."expiresAt") THEN
    RETURN NEW;
  END IF;
  -- Each issuance drains a bounded page of expired bases. User/client erasure
  -- also cascades their bases; no background worker is needed for this profile.
  DELETE FROM public.rezics_oauth_code_basis WHERE id IN (
    SELECT id FROM public.rezics_oauth_code_basis
    WHERE expires_at < now() ORDER BY expires_at LIMIT 128
    FOR UPDATE SKIP LOCKED
  );
  SELECT "skipConsent" INTO client_skip FROM public."oauthClient"
    WHERE "clientId" = code_client;
  IF NOT FOUND THEN RAISE EXCEPTION 'OAuth code client unavailable' USING ERRCODE = '23514'; END IF;
  IF client_skip THEN
    INSERT INTO public.rezics_oauth_code_basis
      (id, client_id, user_id, reference_id, mode, expires_at)
      VALUES (NEW.identifier, code_client, code_user, code_reference, 'trusted', NEW."expiresAt");
  ELSE
    SELECT c.* INTO current_consent FROM public."oauthConsent" c
      WHERE c."userId" = code_user AND c."clientId" = code_client
        AND c."referenceId" IS NOT DISTINCT FROM code_reference
      FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'OAuth code consent unavailable' USING ERRCODE = '23514'; END IF;
    INSERT INTO public.rezics_oauth_code_basis
      (id, client_id, user_id, reference_id, mode, consent_id,
        consent_generation, expires_at)
      VALUES (NEW.identifier, code_client, code_user, code_reference, 'consent',
        current_consent.id, current_consent."rezicsGeneration", NEW."expiresAt");
  END IF;
  RETURN NEW;
END $$;
