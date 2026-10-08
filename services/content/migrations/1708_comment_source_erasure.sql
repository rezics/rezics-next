-- exact, prefix and suffix are copies of revision source bytes. The one comment
-- mutation nulls those three together only while the revision tombstone names
-- the same journal id and epoch. The tombstone row is that binding: a later
-- command in the same transaction cannot replace it with session state. Every
-- other column stays immutable. Existing rows are not rewritten: a cut can
-- still hold selectors until erasure replay after signed coverage comparison.

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
  RETURN NEW;
END $$;

DROP TRIGGER comment_immutable ON content.comment;
CREATE TRIGGER comment_immutable BEFORE UPDATE OR DELETE ON content.comment
  FOR EACH ROW EXECUTE FUNCTION content.comment_source_guard();

-- One statement, not one lookup per comment. A null selector is refused unless
-- that revision's tombstone is already the erased byte cut. The check reads the
-- rows this statement wrote, then the tombstone, and it does not consult
-- session settings that a later command could replace.
CREATE FUNCTION content.comment_source_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM comment_source_changed c
    WHERE (c.exact IS NULL OR c.prefix IS NULL OR c.suffix IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM content.revision_erasure e
        JOIN content.revision r ON r.id = e.revision_id
        WHERE e.revision_id = c.revision_id
          AND r.availability = 'erased'
          AND r.serialized_bytes IS NULL
          AND r.body IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'comment source terminal requires the matching revision tombstone'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER comment_source_terminal_insert
  AFTER INSERT ON content.comment
  REFERENCING NEW TABLE AS comment_source_changed
  FOR EACH STATEMENT EXECUTE FUNCTION content.comment_source_terminal();

CREATE TRIGGER comment_source_terminal_update
  AFTER UPDATE ON content.comment
  REFERENCING NEW TABLE AS comment_source_changed
  FOR EACH STATEMENT EXECUTE FUNCTION content.comment_source_terminal();

-- Stops the open-selector probe at the first remaining quote for a revision.
CREATE INDEX comment_open_source_idx ON content.comment (revision_id)
  WHERE exact IS NOT NULL OR prefix IS NOT NULL OR suffix IS NOT NULL;

-- The caller's journal id and epoch must already be this revision's tombstone.
-- At most 64 revisions, matching the erasure target bound. Selectors then clear
-- in one update. A second call changes nothing.
CREATE FUNCTION content.erase_comment_sources(revision_ids uuid[], erasure uuid, epoch bigint)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  updated integer;
BEGIN
  IF revision_ids IS NULL OR cardinality(revision_ids) < 1 OR cardinality(revision_ids) > 64
     OR EXISTS (SELECT 1 FROM unnest(revision_ids) AS wanted(id) GROUP BY id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'comment source erasure targets are invalid' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(revision_ids) AS wanted(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM content.revision_erasure e
      JOIN content.revision r ON r.id = e.revision_id
      WHERE e.revision_id = wanted.id
        AND e.erasure_id = erasure
        AND e.erasure_epoch = epoch
        AND r.availability = 'erased'
        AND r.serialized_bytes IS NULL
        AND r.body IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'comment source erasure journal does not match the revision tombstone'
      USING ERRCODE = '23514';
  END IF;
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
