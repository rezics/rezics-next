-- An installation admits one registered App (OAuth client) to request tokens
-- up to an explicit scope ceiling. Operator registration installs the client
-- at its declared scopes; a later registration update never changes that
-- ceiling. Revocation is terminal. Reinstalling creates a new installation
-- identity, so tokens, codes and refresh families bound to a revoked one never
-- regain access and a changed ceiling always needs a new installation.
CREATE TABLE IF NOT EXISTS public.rezics_oauth_installation (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES public."oauthClient"("clientId") ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  installed_by text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  change_key text,
  change_digest text,
  revoked_by text,
  revoked_at timestamptz,
  CONSTRAINT rezics_installation_lifecycle CHECK (
    (state = 'active' AND revoked_by IS NULL AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)),
  CONSTRAINT rezics_installation_change CHECK ((change_key IS NULL) = (change_digest IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS rezics_installation_active_client
  ON public.rezics_oauth_installation (client_id) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS rezics_installation_change_key
  ON public.rezics_oauth_installation (client_id, change_key) WHERE change_key IS NOT NULL;

-- The declared ceiling is the distinct union of user and client-credential scopes.
CREATE OR REPLACE FUNCTION public.rezics_declared_scopes(scopes jsonb, workload jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(DISTINCT declared.scope ORDER BY declared.scope), '[]'::jsonb)
  FROM jsonb_array_elements_text(COALESCE(scopes, '[]'::jsonb) || COALESCE(workload, '[]'::jsonb))
    AS declared(scope)
$$;

CREATE OR REPLACE FUNCTION public.rezics_install_registered_client()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.rezics_oauth_installation (id, client_id, state, scopes, installed_by)
    VALUES (gen_random_uuid()::text, NEW."clientId", 'active',
      public.rezics_declared_scopes(NEW.scopes, NEW."clientCredentialsScopes"), 'registration');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_client_installation ON public."oauthClient";
CREATE TRIGGER rezics_client_installation
  AFTER INSERT ON public."oauthClient"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_install_registered_client();

-- Clients registered before installations existed keep their registered
-- ceiling. A client whose installation was revoked stays uninstalled.
INSERT INTO public.rezics_oauth_installation (id, client_id, state, scopes, installed_by)
  SELECT gen_random_uuid()::text, c."clientId", 'active',
    public.rezics_declared_scopes(c.scopes, c."clientCredentialsScopes"), 'registration'
  FROM public."oauthClient" c
  WHERE NOT EXISTS (SELECT 1 FROM public.rezics_oauth_installation i
    WHERE i.client_id = c."clientId");

-- A pending code keeps the installation current at its issuance. A restored
-- code (migration 002) reuses its retained basis row and never rebinds.
ALTER TABLE public.rezics_oauth_code_basis ADD COLUMN IF NOT EXISTS installation_id text;
CREATE OR REPLACE FUNCTION public.rezics_bind_code_installation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT i.id INTO NEW.installation_id FROM public.rezics_oauth_installation i
    WHERE i.client_id = NEW.client_id AND i.state = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth client installation unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_code_installation ON public.rezics_oauth_code_basis;
CREATE TRIGGER rezics_code_installation
  BEFORE INSERT ON public.rezics_oauth_code_basis
  FOR EACH ROW EXECUTE FUNCTION public.rezics_bind_code_installation();

-- A refresh family keeps the installation of its first code. Every insert and
-- rotation locks that row: revocation waits for an earlier token write or
-- makes a later one fail, and no family exceeds the installed ceiling.
-- Families predating this migration have no installation lineage and fail closed.
ALTER TABLE public."oauthRefreshToken" ADD COLUMN IF NOT EXISTS "rezicsInstallationId" text;
CREATE OR REPLACE FUNCTION public.rezics_guard_refresh_installation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  family_installation text;
  installed public.rezics_oauth_installation%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    family_installation := OLD."rezicsInstallationId";
  ELSE
    IF NEW."authorizationCodeId" IS NULL THEN
      RAISE EXCEPTION 'OAuth refresh family has no installation basis' USING ERRCODE = '23514';
    END IF;
    SELECT r."rezicsInstallationId" INTO family_installation
      FROM public."oauthRefreshToken" r
      WHERE r."userId" = NEW."userId" AND r."clientId" = NEW."clientId"
        AND r."authorizationCodeId" = NEW."authorizationCodeId"
        AND r."referenceId" IS NOT DISTINCT FROM NEW."referenceId"
      ORDER BY r."createdAt" LIMIT 1;
    IF NOT FOUND THEN
      SELECT b.installation_id INTO family_installation
        FROM public.rezics_oauth_code_basis b
        WHERE b.id = NEW."authorizationCodeId" AND b.client_id = NEW."clientId"
          AND b.user_id = NEW."userId";
    END IF;
  END IF;
  IF family_installation IS NULL THEN
    RAISE EXCEPTION 'OAuth refresh family has no installation basis' USING ERRCODE = '23514';
  END IF;
  SELECT i.* INTO installed FROM public.rezics_oauth_installation i
    WHERE i.id = family_installation AND i.client_id = NEW."clientId" AND i.state = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth client installation revoked' USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.scopes <@ installed.scopes THEN
    RAISE EXCEPTION 'OAuth installation ceiling exceeded' USING ERRCODE = '23514';
  END IF;
  NEW."rezicsInstallationId" := family_installation;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_refresh_installation_guard ON public."oauthRefreshToken";
CREATE TRIGGER rezics_refresh_installation_guard
  BEFORE INSERT OR UPDATE OF "rotatedAt" ON public."oauthRefreshToken"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_guard_refresh_installation();
