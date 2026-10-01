-- The language of the first sign-up request, used when the person has not chosen one.
ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS signup_locale text;

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
