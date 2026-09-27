-- Plugin base tables are created by Better Auth's migration planner first.
ALTER TABLE public."twoFactor" ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Authenticator';
CREATE UNIQUE INDEX IF NOT EXISTS account_totp_user ON public."twoFactor" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS account_passkey_credential ON public.passkey ("credentialID");
CREATE TABLE IF NOT EXISTS public.rezics_account_step_up (
  session_id text PRIMARY KEY REFERENCES public."session"(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now()
);

-- Password and passkey removals share a user lock, so two concurrent removals
-- cannot each see the other as a remaining method. TOTP/backup codes are second
-- factors, not independent sign-in methods. Cascaded user deletion is allowed.
CREATE OR REPLACE FUNCTION public.rezics_account_last_method() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE remaining integer;
BEGIN
  IF TG_TABLE_NAME = 'account' THEN
    IF OLD."providerId" <> 'credential' OR OLD.password IS NULL THEN
      IF TG_OP = 'UPDATE' THEN RETURN NEW; ELSE RETURN OLD; END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.password IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  PERFORM 1 FROM public."user" WHERE id = OLD."userId" FOR UPDATE;
  IF NOT FOUND THEN RETURN OLD; END IF;
  SELECT (SELECT count(*) FROM public.passkey WHERE "userId" = OLD."userId"
      AND (TG_TABLE_NAME <> 'passkey' OR id <> OLD.id))
    + (SELECT count(*) FROM public.account WHERE "userId" = OLD."userId"
      AND "providerId" = 'credential' AND password IS NOT NULL
      AND (TG_TABLE_NAME <> 'account' OR id <> OLD.id)) INTO remaining;
  IF remaining = 0 THEN RAISE EXCEPTION 'last_sign_in_method' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN RETURN NEW; ELSE RETURN OLD; END IF;
END $$;
DROP TRIGGER IF EXISTS account_last_password ON public.account;
CREATE TRIGGER account_last_password BEFORE DELETE ON public.account
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_last_method();
DROP TRIGGER IF EXISTS account_last_password_update ON public.account;
CREATE TRIGGER account_last_password_update BEFORE UPDATE OF password ON public.account
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_last_method();
DROP TRIGGER IF EXISTS account_last_passkey ON public.passkey;
CREATE TRIGGER account_last_passkey BEFORE DELETE ON public.passkey
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_last_method();

CREATE OR REPLACE FUNCTION public.rezics_account_passkey_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM public."user" WHERE id = NEW."userId" FOR UPDATE;
  IF (SELECT count(*) FROM public.passkey WHERE "userId" = NEW."userId") >= 32 THEN
    RAISE EXCEPTION 'passkey_limit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_passkey_cap ON public.passkey;
CREATE TRIGGER account_passkey_cap BEFORE INSERT ON public.passkey
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_passkey_cap();
