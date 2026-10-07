-- Ordinary sign-out fences session-bound access independently of account and
-- consent generations, so consented external offline access stays admitted.
ALTER TABLE public.rezics_account_security
  ADD COLUMN IF NOT EXISTS session_generation bigint NOT NULL DEFAULT 0
    CHECK (session_generation >= 0),
  ADD COLUMN IF NOT EXISTS session_cleanup_pending boolean NOT NULL DEFAULT false;
ALTER TABLE public."session"
  ADD COLUMN IF NOT EXISTS rezics_generation bigint DEFAULT 0
    CHECK (rezics_generation >= 0);
-- Better Auth's authored additional field may have created this column first.
ALTER TABLE public."session" ALTER COLUMN rezics_generation SET DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public."session"'::regclass
    AND conname = 'account_session_generation_nonnegative') THEN
    ALTER TABLE public."session" ADD CONSTRAINT account_session_generation_nonnegative
      CHECK (rezics_generation >= 0);
  END IF;
END $$;

-- The existing account lock serializes admission with bulk revocation. NULL
-- is a terminal single-session marker; admission always authors a fresh epoch.
CREATE OR REPLACE FUNCTION public.rezics_account_admit_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE policy public.rezics_account_security%ROWTYPE;
BEGIN
  SELECT * INTO policy FROM public.rezics_account_security
    WHERE user_id = NEW."userId" FOR SHARE;
  IF NOT FOUND OR policy.deletion_started_at IS NOT NULL OR policy.password_reset_required OR
    (policy.suspended_at IS NOT NULL AND (policy.suspended_until IS NULL OR policy.suspended_until > now())) THEN
    RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '23514';
  END IF;
  NEW.rezics_generation := policy.session_generation;
  RETURN NEW;
END $$;

-- A code authored by a revoked session cannot be admitted (or restored) after
-- its caller loses access, even while its physical session row awaits cleanup.
CREATE OR REPLACE FUNCTION public.rezics_account_guard_code_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE payload jsonb; epoch bigint; authored public."session"%ROWTYPE;
BEGIN
  BEGIN payload := NEW.value::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END;
  IF payload->>'type' IS DISTINCT FROM 'authorization_code' THEN RETURN NEW; END IF;
  SELECT session_generation INTO epoch FROM public.rezics_account_security
    WHERE user_id = payload->>'userId' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_session' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO authored FROM public."session"
    WHERE id = payload->>'sessionId' AND "userId" = payload->>'userId' FOR SHARE;
  IF NOT FOUND OR authored.rezics_generation IS NULL OR authored.rezics_generation <> epoch
    OR authored."expiresAt" <= now() THEN
    RAISE EXCEPTION 'stale_session' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_session_code_guard ON public.verification;
CREATE TRIGGER rezics_session_code_guard BEFORE INSERT ON public.verification
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_guard_code_session();

-- First-party refresh remains session-bound on both insertion and rotation.
-- External offline families deliberately retain their independent consent
-- basis; existing account/grant/consent/installation guards still apply.
CREATE OR REPLACE FUNCTION public.rezics_account_guard_refresh_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE epoch bigint; authored public."session"%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rezics_oauth_first_party_client
    WHERE client_id = NEW."clientId") THEN RETURN NEW; END IF;
  SELECT session_generation INTO epoch FROM public.rezics_account_security
    WHERE user_id = NEW."userId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_session' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO authored FROM public."session"
    WHERE id = NEW."sessionId" AND "userId" = NEW."userId" FOR SHARE;
  -- Natural browser expiry does not end its retained product offline family;
  -- explicit sign-out/revocation advances or terminates this admission stamp.
  IF NOT FOUND OR authored.rezics_generation IS NULL OR authored.rezics_generation <> epoch THEN
    RAISE EXCEPTION 'stale_session' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_session_refresh_guard ON public."oauthRefreshToken";
CREATE TRIGGER rezics_session_refresh_guard BEFORE INSERT OR UPDATE OF "rotatedAt"
  ON public."oauthRefreshToken"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_guard_refresh_session();

-- Creating or deciding a consent intent must serialize with the same fences.
-- Lock security before session, as the revocation and cleanup paths do.
CREATE OR REPLACE FUNCTION public.rezics_account_guard_pending_consent_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE uid text; epoch bigint; authored public."session"%ROWTYPE;
BEGIN
  SELECT "userId" INTO uid FROM public."session" WHERE id = NEW.session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_session' USING ERRCODE = '23514';
  END IF;
  SELECT session_generation INTO epoch FROM public.rezics_account_security
    WHERE user_id = uid FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_session' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO authored FROM public."session"
    WHERE id = NEW.session_id AND "userId" = uid FOR SHARE;
  IF NOT FOUND OR authored.rezics_generation IS NULL OR authored.rezics_generation <> epoch
    OR authored."expiresAt" <= now() THEN
    RAISE EXCEPTION 'stale_session' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_session_pending_consent_guard ON public.rezics_account_pending_consent;
CREATE TRIGGER rezics_session_pending_consent_guard BEFORE INSERT OR UPDATE OF decided_at
  ON public.rezics_account_pending_consent
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_guard_pending_consent_session();
