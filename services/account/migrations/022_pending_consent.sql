CREATE TABLE IF NOT EXISTS public.rezics_account_pending_consent (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES public."session"(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS account_pending_consent_expiry
  ON public.rezics_account_pending_consent (expires_at);
