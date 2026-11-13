-- migrate:up
-- A tombstone removes authored payload, never an address or an exact binding.
ALTER TABLE content.hosted_placement
  ALTER COLUMN title DROP NOT NULL,
  DROP CONSTRAINT hosted_placement_title_check,
  ADD COLUMN title_redacted boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT hosted_placement_title_check CHECK (
    (title_redacted AND title IS NULL) OR
    (NOT title_redacted AND title IS NOT NULL AND char_length(title) BETWEEN 1 AND 256)
  );
ALTER TABLE content.hosted_append
  ALTER COLUMN title DROP NOT NULL,
  DROP CONSTRAINT hosted_append_title_check,
  ADD COLUMN title_redacted boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT hosted_append_title_check CHECK (
    (title_redacted AND title IS NULL) OR
    (NOT title_redacted AND title IS NOT NULL AND char_length(title) BETWEEN 1 AND 256)
  );

CREATE FUNCTION content.guard_hosted_private_title() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.title_redacted OR NEW.title IS NULL THEN
      RAISE EXCEPTION 'Hosted tombstones require an existing private title' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Hosted identities and snapshots must survive redaction' USING ERRCODE = '23514';
  END IF;
  IF OLD.title_redacted OR OLD.title IS NULL OR NOT NEW.title_redacted OR NEW.title IS NOT NULL
     OR (to_jsonb(NEW) - 'title' - 'title_redacted') IS DISTINCT FROM
        (to_jsonb(OLD) - 'title' - 'title_redacted') THEN
    RAISE EXCEPTION 'Hosted payload permits only one-way title redaction' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM content.hosted_structure_revision r
    WHERE r.route = OLD.route AND r.catalogue_id = OLD.catalogue_id
      AND r.revision_id = OLD.revision_id AND r.kind = 'structure'
  ) THEN
    RAISE EXCEPTION 'Published hosted labels are immutable' USING ERRCODE = '23514';
  END IF;
  -- purge_started_at is native's irreversible eligibility fence: permanent,
  -- expired soft tombstone, or the account-erasure bypass. A deleted_at or
  -- author identity alone is never sufficient. Serialize against native changes.
  PERFORM 1 FROM content.post p
  JOIN content.hosted_catalogue c
    ON c.route = p.route AND c.catalogue_id = p.post_id AND c.thread_id = p.thread_id
  WHERE p.route = OLD.route AND p.post_id = OLD.catalogue_id
    AND ((p.availability = 'erased' AND p.purge_started_at IS NOT NULL)
      OR (p.availability = 'available' AND p.visibility = 'published' AND p.author_erased))
  FOR UPDATE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hosted title redaction requires terminal native authority' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Replace only the two payload guards. Revision/occurrence/descriptor guards
-- remain the blanket immutable guard, including during this migration.
DROP TRIGGER hosted_placement_immutable ON content.hosted_placement;
CREATE TRIGGER hosted_placement_immutable BEFORE INSERT OR UPDATE OR DELETE ON content.hosted_placement
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_private_title();
DROP TRIGGER hosted_append_immutable ON content.hosted_append;
CREATE TRIGGER hosted_append_immutable BEFORE INSERT OR UPDATE OR DELETE ON content.hosted_append
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_private_title();

-- migrate:down
-- Null titles cannot be reconstructed without inventing authored payload.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_placement WHERE title_redacted LIMIT 1)
     OR EXISTS (SELECT 1 FROM content.hosted_append WHERE title_redacted LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back hosted title redaction with retained tombstones' USING ERRCODE = '23514';
  END IF;
END;
$$;
DROP TRIGGER hosted_placement_immutable ON content.hosted_placement;
CREATE TRIGGER hosted_placement_immutable BEFORE UPDATE OR DELETE ON content.hosted_placement
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_snapshot();
DROP TRIGGER hosted_append_immutable ON content.hosted_append;
CREATE TRIGGER hosted_append_immutable BEFORE UPDATE OR DELETE ON content.hosted_append
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_snapshot();
DROP FUNCTION content.guard_hosted_private_title();
ALTER TABLE content.hosted_placement
  DROP CONSTRAINT hosted_placement_title_check,
  DROP COLUMN title_redacted,
  ALTER COLUMN title SET NOT NULL,
  ADD CONSTRAINT hosted_placement_title_check CHECK (char_length(title) BETWEEN 1 AND 256);
ALTER TABLE content.hosted_append
  DROP CONSTRAINT hosted_append_title_check,
  DROP COLUMN title_redacted,
  ALTER COLUMN title SET NOT NULL,
  ADD CONSTRAINT hosted_append_title_check CHECK (char_length(title) BETWEEN 1 AND 256);
