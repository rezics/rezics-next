-- The provider's ordinary sign-in write may race a step-up. Reject its stale
-- snapshot too, so it cannot overwrite a newer step-up counter after our hook.
CREATE OR REPLACE FUNCTION public.rezics_passkey_counter() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF (OLD.counter <> 0 OR NEW.counter <> 0) AND NEW.counter <= OLD.counter THEN
    RAISE EXCEPTION 'stale_passkey_counter' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_passkey_counter ON public.passkey;
CREATE TRIGGER account_passkey_counter BEFORE UPDATE OF counter ON public.passkey
  FOR EACH ROW EXECUTE FUNCTION public.rezics_passkey_counter();
