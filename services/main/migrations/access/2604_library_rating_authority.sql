-- A rating inventory position is not an authority change. Keep it on the
-- principal's indexed row without revoking that principal's saved admissions
-- and library cursor identity whenever a rating changes.
CREATE OR REPLACE FUNCTION access.advance_principal_enforcement_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.library_rating_version IS DISTINCT FROM OLD.library_rating_version
    AND (to_jsonb(NEW) - 'library_rating_version') = (to_jsonb(OLD) - 'library_rating_version') THEN
    RETURN NEW;
  END IF;
  -- Every other update, including one that also advances the inventory, keeps
  -- the original enforcement fence.
  NEW.enforcement_epoch := GREATEST(NEW.enforcement_epoch, OLD.enforcement_epoch + 1);
  RETURN NEW;
END $$;
