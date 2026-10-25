-- migrate:up
-- Rename, rather than visit, legacy history. Old binaries fail closed after this
-- cutover. Stop them before migrating; no new issuer starts until the conservative
-- outstanding-token/hint window has elapsed. The EXISTS probe visits at most one row.
ALTER TABLE auth_signing_key RENAME TO auth_signing_key_archive;
ALTER TABLE auth_signing_key_archive RENAME CONSTRAINT auth_signing_key_pkey TO auth_signing_key_archive_pkey;
CREATE TABLE auth_signing_key (
  kid text PRIMARY KEY,
  slot text NOT NULL UNIQUE CHECK (slot IN ('current', 'next', 'retiring')),
  private_jwk jsonb NOT NULL CHECK (private_jwk->>'d' IS NOT NULL),
  retain_until timestamptz,
  CHECK ((slot = 'retiring') = (retain_until IS NOT NULL))
);
CREATE TABLE auth_signing_generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  current_kid text,
  next_kid text,
  retiring_kid text,
  upgrade_after timestamptz NOT NULL
);
INSERT INTO auth_signing_generation (upgrade_after)
  SELECT statement_timestamp() + CASE WHEN EXISTS (SELECT 1 FROM auth_signing_key_archive LIMIT 1)
    THEN interval '690 seconds' ELSE interval '0 seconds' END;

-- migrate:down
-- Forward only: restoring old binaries would republish retired keys and lose the generation barrier.
