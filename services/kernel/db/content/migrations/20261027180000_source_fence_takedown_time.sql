-- migrate:up
-- Existing takedowns have unknown provenance. Keep their new columns null.
ALTER TABLE content.source_fences
  ADD COLUMN taken_down_at timestamptz,
  ADD COLUMN takedown_id uuid;

CREATE OR REPLACE FUNCTION content.guard_source_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Source fence identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF (NEW.taken_down_at IS NULL) <> (NEW.takedown_id IS NULL)
    OR (NOT NEW.taken_down AND NEW.taken_down_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Source fence takedown time and id must be set together on takedown'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.route, NEW.source, NEW.external_id, NEW.field_group)
        IS DISTINCT FROM ROW(OLD.route, OLD.source, OLD.external_id, OLD.field_group)
      OR NEW.security_revision < OLD.security_revision
      OR (NEW.taken_down IS DISTINCT FROM OLD.taken_down AND NEW.security_revision <= OLD.security_revision) THEN
      RAISE EXCEPTION 'Source fence identity is immutable and takedown requires an increasing security revision'
        USING ERRCODE = '23514';
    END IF;
    IF (OLD.taken_down AND NEW.taken_down)
        AND ROW(NEW.taken_down_at, NEW.takedown_id)
          IS DISTINCT FROM ROW(OLD.taken_down_at, OLD.takedown_id)
      OR (NOT OLD.taken_down AND NEW.taken_down AND NEW.taken_down_at IS NULL) THEN
      RAISE EXCEPTION 'Source fence takedown provenance is immutable and required on transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER source_fence_identity ON content.source_fences;
CREATE TRIGGER source_fence_identity BEFORE INSERT OR UPDATE OR DELETE ON content.source_fences
FOR EACH ROW EXECUTE FUNCTION content.guard_source_fence();

-- migrate:down
-- Forward only: retain original takedown provenance.
