-- The Account browser session records the last OAuth client it authorized.
-- This is display context, not an authorization decision.
ALTER TABLE public."session" ADD COLUMN IF NOT EXISTS rezics_client_id text
  REFERENCES public."oauthClient"("clientId") ON DELETE SET NULL;
