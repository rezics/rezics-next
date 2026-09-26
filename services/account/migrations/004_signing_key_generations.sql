-- Better Auth's jwks table keeps each signing key's material. This table owns
-- the key's lifecycle. Account's JWT keyring adapter reads only live
-- generations, so the pinned plugin publishes and signs from them alone:
-- staged keys are published but never sign, one active key signs, a retiring
-- key only verifies tokens it signed until verify_until, and a retired key is
-- neither published nor accepted. A superseded key's private material is
-- destroyed at supersession, so it can never sign again.
CREATE TABLE IF NOT EXISTS public.rezics_signing_key (
  id text PRIMARY KEY REFERENCES public.jwks(id) ON DELETE RESTRICT,
  generation bigint NOT NULL UNIQUE CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('staged', 'active', 'retiring', 'retired')),
  staged_at timestamptz NOT NULL,
  activated_at timestamptz,
  superseded_at timestamptz,
  verify_until timestamptz,
  retired_at timestamptz,
  retired_reason text CHECK (retired_reason IN ('expired', 'compromised', 'withdrawn')),
  CONSTRAINT rezics_signing_key_lifecycle CHECK (
    (state = 'staged' AND activated_at IS NULL AND superseded_at IS NULL
      AND verify_until IS NULL AND retired_at IS NULL AND retired_reason IS NULL)
    OR (state = 'active' AND activated_at IS NOT NULL AND superseded_at IS NULL
      AND verify_until IS NULL AND retired_at IS NULL AND retired_reason IS NULL)
    OR (state = 'retiring' AND activated_at IS NOT NULL AND superseded_at IS NOT NULL
      AND verify_until > superseded_at AND retired_at IS NULL AND retired_reason IS NULL)
    OR (state = 'retired' AND retired_at IS NOT NULL AND retired_reason IS NOT NULL
      AND (retired_reason = 'withdrawn') = (activated_at IS NULL)))
);
CREATE UNIQUE INDEX IF NOT EXISTS rezics_signing_key_one_active
  ON public.rezics_signing_key ((true)) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS rezics_signing_key_one_staged
  ON public.rezics_signing_key ((true)) WHERE state = 'staged';
CREATE INDEX IF NOT EXISTS rezics_signing_key_live
  ON public.rezics_signing_key (generation) WHERE state <> 'retired';

-- Adopt keys the plugin minted before this migration. The newest unexpired key
-- keeps signing; older keys verify for one access-token lifetime, then retire.
-- Only unmanaged rows change, so reapplying this migration is a no-op.
DO $$
DECLARE
  unmanaged record;
  next_generation bigint;
  newest_live text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rezics_signing_key', 0));
  SELECT COALESCE(max(generation), 0) INTO next_generation FROM public.rezics_signing_key;
  SELECT j.id INTO newest_live FROM public.jwks j
    WHERE NOT EXISTS (SELECT 1 FROM public.rezics_signing_key k WHERE k.id = j.id)
      AND (j."expiresAt" IS NULL OR j."expiresAt" > now())
      AND NOT EXISTS (SELECT 1 FROM public.rezics_signing_key k WHERE k.state = 'active')
    ORDER BY j."createdAt" DESC, j.id DESC LIMIT 1;
  FOR unmanaged IN SELECT j.id, j."createdAt" FROM public.jwks j
    WHERE NOT EXISTS (SELECT 1 FROM public.rezics_signing_key k WHERE k.id = j.id)
    ORDER BY j."createdAt", j.id
  LOOP
    next_generation := next_generation + 1;
    IF unmanaged.id = newest_live THEN
      INSERT INTO public.rezics_signing_key (id, generation, state, staged_at, activated_at)
        VALUES (unmanaged.id, next_generation, 'active', unmanaged."createdAt", unmanaged."createdAt");
    ELSE
      INSERT INTO public.rezics_signing_key
        (id, generation, state, staged_at, activated_at, superseded_at, verify_until)
        VALUES (unmanaged.id, next_generation, 'retiring', unmanaged."createdAt",
          unmanaged."createdAt", now(), now() + interval '305 seconds');
      UPDATE public.jwks SET "privateKey" = 'destroyed' WHERE id = unmanaged.id;
    END IF;
  END LOOP;
END $$;
