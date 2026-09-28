-- The bulk job records an interface locale. zh-CN was the old Simplified tag;
-- the eight UI locales are the only values the column accepts.
UPDATE public.rezics_account_operator_job SET locale = 'zh-Hans' WHERE locale = 'zh-CN';

DO $$
DECLARE name text;
BEGIN
  FOR name IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'rezics_account_operator_job'
      AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%zh-CN%'
  LOOP
    EXECUTE format('ALTER TABLE public.rezics_account_operator_job DROP CONSTRAINT %I', name);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'account_operator_job_locale' AND conrelid = 'public.rezics_account_operator_job'::regclass
  ) THEN
    ALTER TABLE public.rezics_account_operator_job
      ADD CONSTRAINT account_operator_job_locale
      CHECK (locale IN ('en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'));
  END IF;
END $$;

-- The language of the first sign-up request, used when the person has not chosen one.
ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS signup_locale text;

UPDATE public."user" SET signup_locale = locale
WHERE signup_locale IS NULL
  AND locale IN ('en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'account_user_signup_locale' AND conrelid = 'public."user"'::regclass
  ) THEN
    ALTER TABLE public."user"
      ADD CONSTRAINT account_user_signup_locale
      CHECK (signup_locale IS NULL OR signup_locale IN ('en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'));
  END IF;
END $$;
