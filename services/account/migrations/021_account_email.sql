CREATE TABLE IF NOT EXISTS public.rezics_account_email (
  id uuid PRIMARY KEY,
  -- Better Auth calls the sender before the sign-up transaction commits.
  -- Delivery checks the committed user; abandoned sign-ups simply expire.
  user_id text NOT NULL,
  payload text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sending', 'sent', 'expired', 'uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS account_email_pending ON public.rezics_account_email (created_at, id)
  WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS account_email_sending ON public.rezics_account_email (started_at)
  WHERE state = 'sending';

-- A stable, opaque key includes the operation and HMAC of the normalized
-- address/session. Unknown email addresses consume the same budget as known ones.
CREATE TABLE IF NOT EXISTS public.rezics_account_rate_limit (
  key text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS account_rate_limit_age ON public.rezics_account_rate_limit (started_at);
