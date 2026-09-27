-- Product-owned clients are identified independently of consent bypass.
CREATE TABLE IF NOT EXISTS public.rezics_oauth_first_party_client (
  client_id text PRIMARY KEY REFERENCES public."oauthClient"("clientId") ON DELETE CASCADE
);
