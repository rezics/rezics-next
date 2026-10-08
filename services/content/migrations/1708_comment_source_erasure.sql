-- exact, prefix and suffix are copies of revision source bytes. The one comment
-- mutation nulls those three together once this transaction has the revision
-- tombstone for the same journal id and epoch. Every other column stays
-- immutable. Existing rows are not rewritten: a cut can still hold selectors
-- until erasure replay after signed coverage comparison.

DO $$
DECLARE legacy record;
BEGIN
  FOR legacy IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'content.comment'::regclass
      AND con.contype = 'c'
      AND att.attname IN ('exact', 'prefix', 'suffix')
  LOOP
    EXECUTE format('ALTER TABLE content.comment DROP CONSTRAINT %I', legacy.conname);
  END LOOP;
END $$;

ALTER TABLE content.comment
  ALTER COLUMN exact DROP NOT NULL,
  ALTER COLUMN prefix DROP NOT NULL,
  ALTER COLUMN suffix DROP NOT NULL,
  ADD CONSTRAINT comment_source_selector_check CHECK (
    (exact IS NOT NULL AND prefix IS NOT NULL AND suffix IS NOT NULL
      AND length(exact) BETWEEN 1 AND 4096
      AND length(prefix) <= 32
      AND length(suffix) <= 32)
    OR (exact IS NULL AND prefix IS NULL AND suffix IS NULL));

CREATE OR REPLACE FUNCTION content.comment_source_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable Content comment' USING ERRCODE = '23514';
  END IF;
  IF to_jsonb(OLD) - 'exact' - 'prefix' - 'suffix'
     IS DISTINCT FROM to_jsonb(NEW) - 'exact' - 'prefix' - 'suffix' THEN
    RAISE EXCEPTION 'immutable Content comment' USING ERRCODE = '23514';
  END IF;
  IF OLD.exact IS NULL OR OLD.prefix IS NULL OR OLD.suffix IS NULL
     OR NEW.exact IS NOT NULL OR NEW.prefix IS NOT NULL OR NEW.suffix IS NOT NULL THEN
    RAISE EXCEPTION 'immutable Content comment' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM content.revision_erasure e
    JOIN content.revision r ON r.id = e.revision_id
    WHERE e.revision_id = OLD.revision_id
      AND r.availability = 'erased'
      AND e.erasure_id::text = current_setting('rezics.comment_source_erasure_id', true)
      AND e.erasure_epoch::text = current_setting('rezics.comment_source_erasure_epoch', true)
  ) THEN
    RAISE EXCEPTION 'comment source erasure journal does not match the revision tombstone'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER comment_immutable ON content.comment;
CREATE TRIGGER comment_immutable BEFORE UPDATE OR DELETE ON content.comment
  FOR EACH ROW EXECUTE FUNCTION content.comment_source_guard();

-- A null selector written without the named tombstone fails at commit, including
-- an insert that skips the update guard. A populated selector is unchanged.
CREATE FUNCTION content.comment_source_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.exact IS NULL OR NEW.prefix IS NULL OR NEW.suffix IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM content.revision_erasure e
      JOIN content.revision r ON r.id = e.revision_id
      WHERE e.revision_id = NEW.revision_id
        AND r.availability = 'erased'
        AND e.erasure_id::text = current_setting('rezics.comment_source_erasure_id', true)
        AND e.erasure_epoch::text = current_setting('rezics.comment_source_erasure_epoch', true)
    ) THEN
      RAISE EXCEPTION 'comment source terminal requires the matching revision tombstone'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER comment_source_terminal
  AFTER INSERT OR UPDATE ON content.comment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION content.comment_source_terminal();

-- Names the journal identity for the guard, then nulls every still-present
-- selector on the locked comments. A second call updates nothing.
CREATE FUNCTION content.erase_comment_sources(revision_ids uuid[], erasure uuid, epoch bigint)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  updated integer;
BEGIN
  PERFORM set_config('rezics.comment_source_erasure_id', erasure::text, true);
  PERFORM set_config('rezics.comment_source_erasure_epoch', epoch::text, true);
  PERFORM 1 FROM content.comment
    WHERE revision_id = ANY (revision_ids)
    ORDER BY id
    FOR UPDATE;
  UPDATE content.comment
    SET exact = NULL, prefix = NULL, suffix = NULL
    WHERE revision_id = ANY (revision_ids)
      AND (exact IS NOT NULL OR prefix IS NOT NULL OR suffix IS NOT NULL);
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END $$;
