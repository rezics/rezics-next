-- One pending change per immutable account, with a different single-use bearer
-- for each mailbox. Only digests are retained outside the encrypted mail queue.
CREATE TABLE IF NOT EXISTS public.rezics_account_email_change (
  user_id text PRIMARY KEY REFERENCES public."user"(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES public."session"(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  stage text NOT NULL CHECK (stage IN ('confirm', 'verify')),
  old_email text NOT NULL,
  new_email text NOT NULL,
  security_generation bigint NOT NULL CHECK (security_generation >= 0),
  recovery_generation bigint NOT NULL CHECK (recovery_generation >= 0),
  callback_path text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS account_email_change_session
  ON public.rezics_account_email_change (session_id);

-- Password writes, operator security actions and recovery already advance
-- these generations transactionally. Invalidate both stages in that same
-- transaction, including password-reset paths that do not have a session.
CREATE OR REPLACE FUNCTION public.rezics_invalidate_email_change() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.generation IS DISTINCT FROM OLD.generation THEN
    DELETE FROM public.rezics_account_email_change
      WHERE user_id = CASE WHEN TG_TABLE_NAME = 'rezics_account_security'
        THEN to_jsonb(NEW)->>'user_id' ELSE to_jsonb(NEW)->>'id' END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_security_email_change ON public.rezics_account_security;
CREATE TRIGGER account_security_email_change AFTER UPDATE OF generation ON public.rezics_account_security
  FOR EACH ROW EXECUTE FUNCTION public.rezics_invalidate_email_change();
DROP TRIGGER IF EXISTS account_recovery_email_change ON public.rezics_account_recovery_policy;
CREATE TRIGGER account_recovery_email_change AFTER UPDATE OF generation ON public.rezics_account_recovery_policy
  FOR EACH ROW EXECUTE FUNCTION public.rezics_invalidate_email_change();
