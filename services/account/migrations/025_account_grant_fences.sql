CREATE TABLE IF NOT EXISTS public.rezics_account_security (
  user_id text PRIMARY KEY REFERENCES public."user"(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  suspended_at timestamptz,
  suspended_until timestamptz,
  suspension_reason text,
  deletion_started_at timestamptz,
  password_reset_required boolean NOT NULL DEFAULT false
);
INSERT INTO public.rezics_account_security (user_id) SELECT id FROM public."user" ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION public.rezics_account_initialize_security() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO public.rezics_account_security (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_initialize_security ON public."user";
CREATE TRIGGER account_initialize_security AFTER INSERT ON public."user"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_initialize_security();

CREATE TABLE IF NOT EXISTS public.rezics_account_grant (
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES public."oauthClient"("clientId") ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  scopes jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS account_grants_page ON public.rezics_account_grant (user_id, granted_at DESC, client_id DESC);
CREATE INDEX IF NOT EXISTS account_sessions_page ON public."session" ("userId", "createdAt" DESC, id DESC);
CREATE INDEX IF NOT EXISTS account_refresh_user_client ON public."oauthRefreshToken" ("userId", "clientId");
CREATE INDEX IF NOT EXISTS account_installations_client_page ON public.rezics_oauth_installation (client_id, installed_at DESC, id DESC);
INSERT INTO public.rezics_account_grant (user_id, client_id, scopes)
  SELECT "userId", "clientId", scopes FROM public."oauthConsent" ON CONFLICT DO NOTHING;

ALTER TABLE public.rezics_oauth_code_basis ADD COLUMN IF NOT EXISTS account_generation bigint;
ALTER TABLE public.rezics_oauth_code_basis ADD COLUMN IF NOT EXISTS grant_generation bigint;
UPDATE public.rezics_oauth_code_basis SET account_generation = 0, grant_generation = 0
  WHERE account_generation IS NULL;
ALTER TABLE public."oauthRefreshToken" ADD COLUMN IF NOT EXISTS "rezicsAccountGeneration" bigint;
ALTER TABLE public."oauthRefreshToken" ADD COLUMN IF NOT EXISTS "rezicsGrantGeneration" bigint;
UPDATE public."oauthRefreshToken" SET "rezicsAccountGeneration" = 0, "rezicsGrantGeneration" = 0
  WHERE "rezicsAccountGeneration" IS NULL;

CREATE OR REPLACE FUNCTION public.rezics_account_admit_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE policy public.rezics_account_security%ROWTYPE;
BEGIN
  SELECT * INTO policy FROM public.rezics_account_security WHERE user_id = NEW."userId" FOR SHARE;
  IF NOT FOUND OR policy.deletion_started_at IS NOT NULL OR policy.password_reset_required OR
    (policy.suspended_at IS NOT NULL AND (policy.suspended_until IS NULL OR policy.suspended_until > now())) THEN
    RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_admit_session ON public."session";
CREATE TRIGGER account_admit_session BEFORE INSERT ON public."session"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_admit_session();

CREATE OR REPLACE FUNCTION public.rezics_account_bind_code_security() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE payload jsonb; uid text; cid text; policy public.rezics_account_security%ROWTYPE; version bigint;
BEGIN
  BEGIN payload := NEW.value::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END;
  IF payload->>'type' IS DISTINCT FROM 'authorization_code' THEN RETURN NEW; END IF;
  -- A restored verification row keeps its original basis; never reauthorize it.
  IF EXISTS (SELECT 1 FROM public.rezics_oauth_code_basis WHERE id = NEW.identifier AND account_generation IS NOT NULL) THEN RETURN NEW; END IF;
  uid := payload->>'userId'; cid := payload->'query'->>'client_id';
  SELECT * INTO policy FROM public.rezics_account_security WHERE user_id = uid FOR SHARE;
  IF NOT FOUND OR policy.deletion_started_at IS NOT NULL OR policy.password_reset_required OR
    (policy.suspended_at IS NOT NULL AND (policy.suspended_until IS NULL OR policy.suspended_until > now())) THEN
    RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.rezics_account_grant (user_id, client_id, scopes)
    VALUES (uid, cid, to_jsonb(string_to_array(payload->'query'->>'scope', ' ')))
    ON CONFLICT (user_id, client_id) DO UPDATE SET granted_at = now(), revoked_at = NULL, scopes = EXCLUDED.scopes
    RETURNING generation INTO version;
  UPDATE public.rezics_oauth_code_basis SET account_generation = policy.generation, grant_generation = version
    WHERE id = NEW.identifier AND account_generation IS NULL;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_security_code_basis ON public."verification";
CREATE TRIGGER rezics_security_code_basis AFTER INSERT ON public."verification"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_bind_code_security();

CREATE OR REPLACE FUNCTION public.rezics_account_guard_refresh_security() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE policy public.rezics_account_security%ROWTYPE; grant_version bigint; account_basis bigint; grant_basis bigint;
BEGIN
  SELECT * INTO policy FROM public.rezics_account_security WHERE user_id = NEW."userId" FOR SHARE;
  IF NOT FOUND OR policy.deletion_started_at IS NOT NULL OR policy.password_reset_required OR
    (policy.suspended_at IS NOT NULL AND (policy.suspended_until IS NULL OR policy.suspended_until > now())) THEN
    RAISE EXCEPTION 'account_unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT generation INTO grant_version FROM public.rezics_account_grant
    WHERE user_id = NEW."userId" AND client_id = NEW."clientId" FOR SHARE;
  IF NOT FOUND THEN grant_version := 0; END IF;
  IF TG_OP = 'UPDATE' THEN
    account_basis := OLD."rezicsAccountGeneration"; grant_basis := OLD."rezicsGrantGeneration";
  ELSE
    SELECT "rezicsAccountGeneration", "rezicsGrantGeneration" INTO account_basis, grant_basis
      FROM public."oauthRefreshToken" WHERE "userId" = NEW."userId" AND "clientId" = NEW."clientId"
        AND "authorizationCodeId" = NEW."authorizationCodeId" ORDER BY "createdAt" LIMIT 1;
    IF NOT FOUND THEN
      SELECT account_generation, grant_generation INTO account_basis, grant_basis
        FROM public.rezics_oauth_code_basis WHERE id = NEW."authorizationCodeId";
    END IF;
  END IF;
  IF account_basis IS DISTINCT FROM policy.generation OR grant_basis IS DISTINCT FROM grant_version THEN
    RAISE EXCEPTION 'stale_account_grant' USING ERRCODE = '23514';
  END IF;
  NEW."rezicsAccountGeneration" := account_basis; NEW."rezicsGrantGeneration" := grant_basis;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_security_refresh_guard ON public."oauthRefreshToken";
CREATE TRIGGER rezics_security_refresh_guard BEFORE INSERT OR UPDATE OF "rotatedAt" ON public."oauthRefreshToken"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_guard_refresh_security();

-- A password change/reset invalidates all OAuth families, including trusted
-- clients, atomically with the credential change. Unlock reset-required only
-- after a new credential has actually been stored.
CREATE OR REPLACE FUNCTION public.rezics_account_password_fence() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW."providerId" <> 'credential' OR NEW.password IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.rezics_account_security WHERE user_id = NEW."userId" AND password_reset_required) THEN RETURN NEW; END IF;
  ELSIF OLD.password IS NOT DISTINCT FROM NEW.password THEN RETURN NEW;
  END IF;
    UPDATE public.rezics_account_security SET generation = generation + 1, password_reset_required = false
      WHERE user_id = NEW."userId";
    DELETE FROM public."session" WHERE "userId" = NEW."userId";
    DELETE FROM public.verification WHERE value = NEW."userId";
    UPDATE public."oauthRefreshToken" SET revoked = now() WHERE "userId" = NEW."userId" AND revoked IS NULL;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_password_fence ON public.account;
CREATE TRIGGER account_password_fence AFTER INSERT OR UPDATE OF password ON public.account
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_password_fence();
