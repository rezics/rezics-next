-- Better Auth's passkey table records no use. The account centre shows when
-- each passkey last signed in or confirmed a sensitive change; the passkey's
-- verified assertion writes it (src/account-settings.ts).
ALTER TABLE public.passkey ADD COLUMN IF NOT EXISTS "rezicsLastUsedAt" timestamptz;
