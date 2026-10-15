-- A password/passkey freshness stamp alone does not prove the current TOTP.
ALTER TABLE public.rezics_account_step_up ADD COLUMN IF NOT EXISTS totp_factor_id text;

-- Provider trust identifiers are user-bound verification rows. Retire every
-- remembered device on replacement, including devices absent from the request.
CREATE OR REPLACE FUNCTION public.rezics_retire_factor_trust() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'UPDATE' AND NEW.secret IS NOT DISTINCT FROM OLD.secret
    AND NEW."userId" = OLD."userId" THEN RETURN NEW; END IF;
  DELETE FROM public.verification WHERE value = OLD."userId"
    AND identifier LIKE 'trust-device-%';
  DELETE FROM public.rezics_account_step_up WHERE session_id IN (
    SELECT id FROM public."session" WHERE "userId" = OLD."userId");
  IF TG_OP = 'UPDATE' THEN RETURN NEW; ELSE RETURN OLD; END IF;
END $$;
DROP TRIGGER IF EXISTS account_factor_trust ON public."twoFactor";
CREATE TRIGGER account_factor_trust BEFORE UPDATE OR DELETE ON public."twoFactor"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_retire_factor_trust();
