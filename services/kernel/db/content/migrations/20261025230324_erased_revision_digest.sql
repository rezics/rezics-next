-- migrate:up
ALTER TABLE content.revision
  ALTER COLUMN body_sha256 DROP NOT NULL,
  DROP CONSTRAINT revision_body_sha256_matches;

-- The old guard freezes the digest even after physical erasure. The migration's
-- table lock keeps this repair private until the new constraint and guard commit.
ALTER TABLE content.revision DISABLE TRIGGER revision_immutable;
UPDATE content.revision SET body_sha256 = NULL
WHERE body IS NULL AND body_sha256 IS NOT NULL;
ALTER TABLE content.revision ENABLE TRIGGER revision_immutable;

ALTER TABLE content.revision ADD CONSTRAINT revision_body_sha256_matches
  CHECK (body_sha256 IS NOT DISTINCT FROM sha256(body));

CREATE OR REPLACE FUNCTION content.guard_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Revision identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.thread_id, NEW.post_id, NEW.revision_id,
         NEW.licence, NEW.subject_ids, NEW.board_id, NEW.recorded_transaction_id, NEW.recorded_at, NEW.media_ids)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.thread_id, OLD.post_id, OLD.revision_id,
         OLD.licence, OLD.subject_ids, OLD.board_id, OLD.recorded_transaction_id, OLD.recorded_at, OLD.media_ids)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased'
     OR OLD.body IS NULL OR OLD.body_sha256 IS NULL
     OR NEW.body IS NOT NULL OR NEW.body_sha256 IS NOT NULL OR NEW.search_text IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM content.post p
       WHERE p.route = OLD.route AND p.thread_id = OLD.thread_id AND p.post_id = OLD.post_id
         AND p.availability = 'erased'
     ) THEN
    RAISE EXCEPTION 'Revisions are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down
-- Forward only: erased digests cannot be recovered.
