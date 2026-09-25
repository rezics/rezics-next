-- The provider updates a saved consent row in place. A new opaque generation
-- on every update keeps narrowing/re-consent from reviving an older family.
-- Rows predating this migration have no refresh lineage and fail closed.
ALTER TABLE public."oauthConsent"
  ADD COLUMN IF NOT EXISTS "rezicsGeneration" uuid DEFAULT gen_random_uuid();
UPDATE public."oauthConsent" SET "rezicsGeneration" = gen_random_uuid()
  WHERE "rezicsGeneration" IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public."oauthConsent"'::regclass
      AND conname = 'rezics_consent_generation_required') THEN
    ALTER TABLE public."oauthConsent"
      ADD CONSTRAINT rezics_consent_generation_required
      CHECK ("rezicsGeneration" IS NOT NULL);
  END IF;
END $$;
ALTER TABLE public."oauthRefreshToken"
  ADD COLUMN IF NOT EXISTS "rezicsConsentId" text;
ALTER TABLE public."oauthRefreshToken"
  ADD COLUMN IF NOT EXISTS "rezicsConsentGeneration" uuid;
ALTER TABLE public."oauthRefreshToken"
  ADD COLUMN IF NOT EXISTS "rezicsAuthMode" text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public."oauthRefreshToken"'::regclass
      AND conname = 'rezics_refresh_auth_mode_check') THEN
    ALTER TABLE public."oauthRefreshToken"
      ADD CONSTRAINT rezics_refresh_auth_mode_check
      CHECK ("rezicsAuthMode" IS NULL OR "rezicsAuthMode" IN ('consent', 'trusted'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS rezics_consent_basis_unique
  ON public."oauthConsent" ("userId", "clientId", "referenceId") NULLS NOT DISTINCT;

CREATE OR REPLACE FUNCTION public.rezics_advance_consent_generation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."rezicsGeneration" := gen_random_uuid();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_consent_generation ON public."oauthConsent";
CREATE TRIGGER rezics_consent_generation
  BEFORE UPDATE ON public."oauthConsent"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_advance_consent_generation();

CREATE OR REPLACE FUNCTION public.rezics_guard_refresh_consent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_consent public."oauthConsent"%ROWTYPE;
  client_skip boolean;
  family_consent_id text;
  family_generation uuid;
  family_mode text;
  family_found boolean := false;
  effective_mode text;
BEGIN
  SELECT "skipConsent" INTO client_skip FROM public."oauthClient"
    WHERE "clientId" = NEW."clientId";
  IF NOT FOUND THEN RAISE EXCEPTION 'OAuth client unavailable' USING ERRCODE = '23514'; END IF;

  IF TG_OP = 'UPDATE' THEN
    effective_mode := OLD."rezicsAuthMode";
    family_consent_id := OLD."rezicsConsentId";
    family_generation := OLD."rezicsConsentGeneration";
  ELSE
    IF NEW."authorizationCodeId" IS NOT NULL THEN
      SELECT r."rezicsAuthMode", r."rezicsConsentId", r."rezicsConsentGeneration"
        INTO family_mode, family_consent_id, family_generation
        FROM public."oauthRefreshToken" r
        WHERE r."userId" = NEW."userId" AND r."clientId" = NEW."clientId"
          AND r."authorizationCodeId" = NEW."authorizationCodeId"
        ORDER BY r."createdAt" LIMIT 1;
      family_found := FOUND;
    END IF;
    IF family_found THEN
      effective_mode := family_mode;
    ELSIF client_skip THEN
      effective_mode := 'trusted';
    ELSE
      effective_mode := 'consent';
    END IF;
  END IF;

  IF effective_mode = 'trusted' THEN
    IF NOT client_skip THEN
      RAISE EXCEPTION 'trusted OAuth refresh family is no longer admitted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW."rezicsAuthMode" := 'trusted';
      NEW."rezicsConsentId" := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF effective_mode IS DISTINCT FROM 'consent' OR NEW."authorizationCodeId" IS NULL THEN
    RAISE EXCEPTION 'OAuth refresh family has no admitted consent basis' USING ERRCODE = '23514';
  END IF;

  -- FOR SHARE is held until this provider adapter write commits. A concurrent
  -- consent UPDATE/DELETE waits; a later token write observes the new basis.
  SELECT c.* INTO current_consent FROM public."oauthConsent" c
    WHERE c."userId" = NEW."userId" AND c."clientId" = NEW."clientId"
      AND c."referenceId" IS NOT DISTINCT FROM NEW."referenceId"
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OAuth consent revoked' USING ERRCODE = '23514'; END IF;
  IF NOT NEW.scopes <@ current_consent.scopes
    OR (NEW.resources IS NOT NULL AND NOT NEW.resources <@ COALESCE(current_consent.resources, ARRAY[]::text[]))
  THEN RAISE EXCEPTION 'OAuth consent ceiling changed' USING ERRCODE = '23514'; END IF;

  IF TG_OP = 'UPDATE' THEN
    IF family_consent_id IS DISTINCT FROM current_consent.id
      OR family_generation IS DISTINCT FROM current_consent."rezicsGeneration" THEN
      RAISE EXCEPTION 'OAuth refresh family has stale consent' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF family_found AND (family_consent_id IS DISTINCT FROM current_consent.id
      OR family_generation IS DISTINCT FROM current_consent."rezicsGeneration") THEN
      RAISE EXCEPTION 'OAuth refresh family has stale consent' USING ERRCODE = '23514';
    END IF;
    NEW."rezicsAuthMode" := 'consent';
    NEW."rezicsConsentId" := current_consent.id;
    NEW."rezicsConsentGeneration" := current_consent."rezicsGeneration";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS rezics_refresh_consent_guard ON public."oauthRefreshToken";
CREATE TRIGGER rezics_refresh_consent_guard
  BEFORE INSERT OR UPDATE OF "rotatedAt" ON public."oauthRefreshToken"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_guard_refresh_consent();
