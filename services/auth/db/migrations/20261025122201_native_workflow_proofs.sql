-- migrate:up
-- Existing installations already have staging. Fresh installations acquire the
-- same fields in the original, future-stamped staging migration.
DO $$
BEGIN
  IF to_regclass('auth_registration_stage') IS NOT NULL THEN
    ALTER TABLE auth_registration_stage
      ADD COLUMN IF NOT EXISTS pending_reference text,
      ADD COLUMN IF NOT EXISTS automated_reference text,
      ADD COLUMN IF NOT EXISTS creation_binding jsonb;
  END IF;
END;
$$;

-- migrate:down
-- Forward only: original command locators survive workflow recovery.
