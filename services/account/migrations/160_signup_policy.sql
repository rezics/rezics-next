ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS birth_month text
  CHECK (birth_month ~ '^\d{4}-(0[1-9]|1[0-2])$');
-- Private initial receipt supplied by the user-create hook; the trigger journals
-- acceptance in the same transaction as creation, including rollback on failure.
ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS signup_policies jsonb;
CREATE TABLE IF NOT EXISTS public.rezics_policy_acceptance (
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  policy_id text NOT NULL CHECK (policy_id IN ('terms', 'privacy')),
  version_digest text NOT NULL CHECK (version_digest ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, policy_id, version_digest)
);
CREATE OR REPLACE FUNCTION public.rezics_signup_policy_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO public.rezics_policy_acceptance (user_id, policy_id, version_digest)
    SELECT NEW.id, item->>'policyId', item->>'versionDigest'
    FROM jsonb_array_elements(COALESCE(NEW.signup_policies->'acceptedPolicies', '[]'::jsonb)) item;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rezics_signup_policy_receipt ON public."user";
CREATE TRIGGER rezics_signup_policy_receipt AFTER INSERT ON public."user"
FOR EACH ROW EXECUTE FUNCTION public.rezics_signup_policy_receipt();
