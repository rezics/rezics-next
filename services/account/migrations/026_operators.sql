CREATE TABLE IF NOT EXISTS public.rezics_account_operator (
  user_id text PRIMARY KEY REFERENCES public."user"(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'support')),
  assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.rezics_account_operator_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.rezics_account_operator_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL,
  action text NOT NULL,
  target_id text NOT NULL,
  reason text NOT NULL,
  before_summary jsonb,
  after_summary jsonb,
  request_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('attempted', 'succeeded', 'failed')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS account_audit_page ON public.rezics_account_operator_audit (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS account_audit_actor ON public.rezics_account_operator_audit (actor_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS account_audit_target ON public.rezics_account_operator_audit (target_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS account_audit_action ON public.rezics_account_operator_audit (action, occurred_at DESC, id DESC);
DROP TRIGGER IF EXISTS account_audit_append_only ON public.rezics_account_operator_audit;
CREATE TRIGGER account_audit_append_only BEFORE UPDATE OR DELETE ON public.rezics_account_operator_audit
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_append_only();

CREATE TABLE IF NOT EXISTS public.rezics_account_operator_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  author_id text NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS account_note_user ON public.rezics_account_operator_note (user_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS public.rezics_account_operator_command (
  actor_id text NOT NULL,
  command_id uuid NOT NULL,
  digest text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, command_id)
);
CREATE INDEX IF NOT EXISTS account_directory_created ON public."user" ("createdAt", id);
CREATE INDEX IF NOT EXISTS account_directory_email ON public."user" (lower(email), id);
CREATE INDEX IF NOT EXISTS account_directory_name ON public."user" (lower(name), id);
CREATE INDEX IF NOT EXISTS account_directory_email_prefix ON public."user" (lower(email) text_pattern_ops);
CREATE INDEX IF NOT EXISTS account_directory_name_prefix ON public."user" (lower(name) text_pattern_ops);
CREATE INDEX IF NOT EXISTS account_directory_id_prefix ON public."user" (lower(id) text_pattern_ops);

CREATE OR REPLACE FUNCTION public.rezics_account_last_owner() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('account-operator-roles', 0));
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' THEN RETURN NEW; END IF;
  IF OLD.role = 'owner' AND NOT EXISTS (
    SELECT 1 FROM public.rezics_account_operator o JOIN public.rezics_account_security s ON s.user_id = o.user_id
    WHERE o.role = 'owner' AND o.user_id <> OLD.user_id AND s.deletion_started_at IS NULL
      AND NOT s.password_reset_required AND (s.suspended_at IS NULL OR s.suspended_until <= now())) THEN
    RAISE EXCEPTION 'last_owner' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN RETURN NEW; ELSE RETURN OLD; END IF;
END $$;
DROP TRIGGER IF EXISTS account_last_owner ON public.rezics_account_operator;
CREATE TRIGGER account_last_owner BEFORE UPDATE OR DELETE ON public.rezics_account_operator
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_last_owner();
