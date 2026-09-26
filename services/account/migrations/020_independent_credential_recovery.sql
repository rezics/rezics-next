-- A recovery code is enrolled while the Account credential is still known.
-- A different Account user must approve its use. Claims, approvals and
-- activations are retained separately; only the policy's current code and
-- generation change. Old OAuth evidence never acquires a new generation.
CREATE TABLE IF NOT EXISTS public.rezics_account_recovery_policy (
  id text PRIMARY KEY REFERENCES public."user"(id) ON DELETE CASCADE,
  guardian_user_id text NOT NULL REFERENCES public."user"(id),
  code_hash text CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$'),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  recovered_at timestamptz,
  CHECK (id <> guardian_user_id)
);
CREATE INDEX IF NOT EXISTS account_recovery_guardian
  ON public.rezics_account_recovery_policy (guardian_user_id);

CREATE TABLE IF NOT EXISTS public.rezics_account_recovery_claim (
  id uuid PRIMARY KEY,
  target_user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  policy_generation bigint NOT NULL CHECK (policy_generation >= 0),
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  not_before timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > not_before)
);
CREATE INDEX IF NOT EXISTS account_recovery_claim_target
  ON public.rezics_account_recovery_claim (target_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS public.rezics_account_recovery_approval (
  id uuid PRIMARY KEY REFERENCES public.rezics_account_recovery_claim(id),
  approver_user_id text NOT NULL REFERENCES public."user"(id),
  approved_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.rezics_account_recovery_activation (
  id uuid PRIMARY KEY REFERENCES public.rezics_account_recovery_claim(id),
  activation_digest text NOT NULL CHECK (activation_digest ~ '^[0-9a-f]{64}$'),
  recovery_generation bigint NOT NULL CHECK (recovery_generation > 0),
  activated_at timestamptz NOT NULL DEFAULT now()
);

-- Existing pending codes and refresh families predate recovery policies and
-- retain generation zero. New codes receive their generation only at first
-- issuance; a restored verification row cannot rebind an old basis.
ALTER TABLE public.rezics_oauth_code_basis
  ADD COLUMN IF NOT EXISTS recovery_generation bigint;
UPDATE public.rezics_oauth_code_basis SET recovery_generation = 0
  WHERE recovery_generation IS NULL;
ALTER TABLE public."oauthRefreshToken"
  ADD COLUMN IF NOT EXISTS "rezicsRecoveryGeneration" bigint;
UPDATE public."oauthRefreshToken" SET "rezicsRecoveryGeneration" = 0
  WHERE "rezicsRecoveryGeneration" IS NULL;

CREATE OR REPLACE FUNCTION public.rezics_bind_code_recovery() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payload jsonb;
  code_user text;
  code_session text;
  current_generation bigint := 0;
  last_recovery timestamptz;
BEGIN
  BEGIN payload := NEW.value::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RETURN NEW;
  END;
  IF payload->>'type' IS DISTINCT FROM 'authorization_code' THEN RETURN NEW; END IF;
  code_user := payload->>'userId';
  code_session := payload->>'sessionId';
  IF code_user IS NULL OR code_session IS NULL THEN
    RAISE EXCEPTION 'OAuth code recovery identity unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT generation, recovered_at INTO current_generation, last_recovery
    FROM public.rezics_account_recovery_policy WHERE id = code_user FOR SHARE;
  IF NOT FOUND THEN current_generation := 0; last_recovery := NULL; END IF;
  PERFORM 1 FROM public."session" s WHERE s.id = code_session
    AND s."userId" = code_user AND s."expiresAt" > clock_timestamp()
    AND (last_recovery IS NULL OR s."createdAt" > last_recovery) FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth code session predates credential recovery' USING ERRCODE = '23514';
  END IF;
  UPDATE public.rezics_oauth_code_basis
    SET recovery_generation = current_generation
    WHERE id = NEW.identifier AND user_id = code_user
      AND recovery_generation IS NULL;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_recovery_code_basis ON public."verification";
CREATE TRIGGER rezics_recovery_code_basis AFTER INSERT ON public."verification"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_bind_code_recovery();

CREATE OR REPLACE FUNCTION public.rezics_guard_refresh_recovery() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  family_generation bigint;
  current_generation bigint := 0;
BEGIN
  SELECT generation INTO current_generation FROM public.rezics_account_recovery_policy
    WHERE id = NEW."userId" FOR SHARE;
  IF NOT FOUND THEN current_generation := 0; END IF;
  IF TG_OP = 'UPDATE' THEN
    family_generation := OLD."rezicsRecoveryGeneration";
  ELSE
    SELECT r."rezicsRecoveryGeneration" INTO family_generation
      FROM public."oauthRefreshToken" r
      WHERE r."userId" = NEW."userId" AND r."clientId" = NEW."clientId"
        AND r."authorizationCodeId" = NEW."authorizationCodeId"
        AND r."referenceId" IS NOT DISTINCT FROM NEW."referenceId"
      ORDER BY r."createdAt" LIMIT 1;
    IF NOT FOUND THEN
      SELECT b.recovery_generation INTO family_generation
        FROM public.rezics_oauth_code_basis b
        WHERE b.id = NEW."authorizationCodeId" AND b.user_id = NEW."userId"
          AND b.client_id = NEW."clientId";
    END IF;
  END IF;
  IF family_generation IS NULL OR family_generation <> current_generation THEN
    RAISE EXCEPTION 'OAuth refresh family predates credential recovery' USING ERRCODE = '23514';
  END IF;
  NEW."rezicsRecoveryGeneration" := family_generation;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_refresh_recovery_guard ON public."oauthRefreshToken";
CREATE TRIGGER rezics_refresh_recovery_guard
  BEFORE INSERT OR UPDATE OF "rotatedAt" ON public."oauthRefreshToken"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_guard_refresh_recovery();
