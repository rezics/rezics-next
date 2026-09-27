CREATE TABLE IF NOT EXISTS public.rezics_account_security_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS account_security_user_page
  ON public.rezics_account_security_event (user_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS account_security_user_action
  ON public.rezics_account_security_event (user_id, action, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.rezics_account_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Account history is append-only' USING ERRCODE = '23514'; END $$;
DROP TRIGGER IF EXISTS account_security_append_only ON public.rezics_account_security_event;
CREATE TRIGGER account_security_append_only BEFORE UPDATE OR DELETE ON public.rezics_account_security_event
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_append_only();

CREATE OR REPLACE FUNCTION public.rezics_account_security_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE before_row jsonb; after_row jsonb; subject text; event text; detail jsonb := '{}';
BEGIN
  before_row := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  after_row := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
  subject := coalesce(after_row->>'userId', before_row->>'userId', after_row->>'id', before_row->>'id');
  IF TG_TABLE_NAME = 'user' AND before_row->>'email' IS DISTINCT FROM after_row->>'email' THEN
    event := 'email_changed';
  ELSIF TG_TABLE_NAME = 'account' AND coalesce(after_row->>'providerId', before_row->>'providerId') = 'credential' THEN
    IF TG_OP = 'INSERT' THEN event := 'password_added';
    ELSIF TG_OP = 'DELETE' THEN event := 'password_removed';
    ELSIF before_row->>'password' IS DISTINCT FROM after_row->>'password' THEN event := 'password_changed'; END IF;
  ELSIF TG_TABLE_NAME = 'passkey' THEN
    IF TG_OP = 'INSERT' THEN event := 'passkey_added';
    ELSIF TG_OP = 'DELETE' THEN event := 'passkey_removed';
    ELSIF before_row->>'name' IS DISTINCT FROM after_row->>'name' THEN event := 'passkey_renamed'; END IF;
  ELSIF TG_TABLE_NAME = 'twoFactor' THEN
    IF TG_OP = 'DELETE' THEN event := 'totp_removed';
    ELSIF after_row->>'verified' = 'true' AND before_row->>'verified' IS DISTINCT FROM 'true' THEN event := 'totp_added';
    ELSIF before_row->>'name' IS DISTINCT FROM after_row->>'name' AND TG_OP = 'UPDATE' THEN event := 'totp_renamed';
    ELSIF TG_OP = 'UPDATE' AND before_row->>'backupCodes' IS DISTINCT FROM after_row->>'backupCodes' THEN event := 'backup_codes_changed'; END IF;
  ELSIF TG_TABLE_NAME = 'session' THEN
    event := 'session_revoked'; detail := jsonb_build_object('sessionId', before_row->>'id');
  ELSIF TG_TABLE_NAME = 'oauthConsent' THEN
    event := CASE WHEN TG_OP = 'DELETE' THEN 'consent_revoked' ELSE 'consent_granted' END;
    detail := jsonb_build_object('clientId', coalesce(after_row->>'clientId', before_row->>'clientId'));
  END IF;
  IF event IS NOT NULL THEN
    INSERT INTO public.rezics_account_security_event (user_id, action, detail) VALUES (subject, event, detail);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS account_event_password ON public.account;
CREATE TRIGGER account_event_password AFTER INSERT OR UPDATE OR DELETE ON public.account
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_security_change();
DROP TRIGGER IF EXISTS account_event_passkey ON public.passkey;
CREATE TRIGGER account_event_passkey AFTER INSERT OR UPDATE OR DELETE ON public.passkey
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_security_change();
DROP TRIGGER IF EXISTS account_event_totp ON public."twoFactor";
CREATE TRIGGER account_event_totp AFTER INSERT OR UPDATE OR DELETE ON public."twoFactor"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_security_change();
DROP TRIGGER IF EXISTS account_event_email ON public."user";
CREATE TRIGGER account_event_email AFTER UPDATE OF email ON public."user"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_security_change();
DROP TRIGGER IF EXISTS account_event_session ON public."session";
CREATE TRIGGER account_event_session AFTER DELETE ON public."session"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_security_change();
DROP TRIGGER IF EXISTS account_event_consent ON public."oauthConsent";
CREATE TRIGGER account_event_consent AFTER INSERT OR UPDATE OR DELETE ON public."oauthConsent"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_account_security_change();
