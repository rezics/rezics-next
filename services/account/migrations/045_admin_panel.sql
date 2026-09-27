-- The operator panel: sanctions carry a reason code and an optional message
-- to the user; each operator keeps their own display preferences; bulk
-- actions run as background jobs with a result per user; partial indexes
-- keep the overview's work queues and failure filters bounded.
ALTER TABLE public.rezics_account_operator_audit ADD COLUMN IF NOT EXISTS reason_code text;
ALTER TABLE public.rezics_account_operator_audit ADD COLUMN IF NOT EXISTS user_message text;
ALTER TABLE public.rezics_account_security ADD COLUMN IF NOT EXISTS suspension_code text;

CREATE INDEX IF NOT EXISTS account_audit_unsuccessful ON public.rezics_account_operator_audit (outcome, occurred_at DESC, id DESC)
  WHERE outcome <> 'succeeded';
CREATE INDEX IF NOT EXISTS account_queue_suspended ON public.rezics_account_security (suspended_until NULLS LAST, user_id)
  WHERE suspended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_queue_reset_required ON public.rezics_account_security (user_id)
  WHERE password_reset_required;
CREATE INDEX IF NOT EXISTS account_queue_unverified ON public."user" ("createdAt" DESC, id)
  WHERE NOT "emailVerified";
CREATE INDEX IF NOT EXISTS account_queue_failed_sign_in ON public.rezics_account_security_event (occurred_at DESC, user_id)
  WHERE action = 'sign_in_failed';

CREATE TABLE IF NOT EXISTS public.rezics_account_operator_preference (
  user_id text PRIMARY KEY REFERENCES public."user"(id) ON DELETE CASCADE,
  density text NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable', 'compact')),
  columns jsonb,
  views jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A job keeps the authority it was admitted under (actor and session); each
-- item commits its effect, audit record and result in one transaction, so a
-- restarted runner resumes exactly the pending items.
CREATE TABLE IF NOT EXISTS public.rezics_account_operator_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL,
  session_id text NOT NULL,
  command_id uuid NOT NULL,
  digest text NOT NULL,
  action text NOT NULL,
  reason_code text NOT NULL,
  reason text NOT NULL,
  user_message text,
  expires_at timestamptz,
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (actor_id, command_id)
);
CREATE INDEX IF NOT EXISTS account_job_actor ON public.rezics_account_operator_job (actor_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS public.rezics_account_operator_job_item (
  job_id uuid NOT NULL REFERENCES public.rezics_account_operator_job(id),
  position integer NOT NULL CHECK (position >= 0),
  user_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'succeeded', 'skipped', 'failed')),
  error text,
  request_id uuid,
  finished_at timestamptz,
  PRIMARY KEY (job_id, position)
);
CREATE INDEX IF NOT EXISTS account_job_pending ON public.rezics_account_operator_job_item (job_id, position)
  WHERE state = 'pending';
