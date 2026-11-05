-- migrate:up
-- A partition-local marker carries the already verified account erasure obligation.
-- It permits erasing only non-head history of a retained published post.
ALTER TABLE content.post ADD COLUMN author_erased boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION content.guard_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Revision identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.thread_id, NEW.post_id, NEW.revision_id,
         NEW.licence, NEW.subject_ids, NEW.board_id, NEW.recorded_transaction_id, NEW.recorded_at,
         NEW.media_ids, NEW.vote_citation)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.thread_id, OLD.post_id, OLD.revision_id,
         OLD.licence, OLD.subject_ids, OLD.board_id, OLD.recorded_transaction_id, OLD.recorded_at,
         OLD.media_ids, OLD.vote_citation)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased'
     OR OLD.body IS NULL OR OLD.body_sha256 IS NULL
     OR NEW.body IS NOT NULL OR NEW.body_sha256 IS NOT NULL OR NEW.search_text IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM content.post p
       WHERE p.route = OLD.route AND p.thread_id = OLD.thread_id AND p.post_id = OLD.post_id
         AND (p.availability = 'erased' OR
           (p.author_erased AND p.availability = 'available' AND p.visibility = 'published'
            AND p.head_revision_id <> OLD.revision_id))
     ) THEN
    RAISE EXCEPTION 'Revisions are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION content.guard_post_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.author_erased AND NOT NEW.author_erased THEN
    RAISE EXCEPTION 'Author erasure is irreversible' USING ERRCODE = '23514';
  END IF;
  IF OLD.availability = 'erased' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Erased post identity must survive cleanup' USING ERRCODE = '23514';
    END IF;
    IF NEW.head_revision_id IS DISTINCT FROM OLD.head_revision_id
       OR (NEW.availability = 'erased' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
       OR (NEW.availability <> 'erased' AND
           (OLD.deleted_at IS NULL OR OLD.purge_started_at IS NOT NULL OR OLD.purge_completed)) THEN
      RAISE EXCEPTION 'Purged post erasure is irreversible' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF OLD.purge_started_at IS NOT NULL AND NEW.purge_started_at IS DISTINCT FROM OLD.purge_started_at
     OR OLD.purge_completed AND NOT NEW.purge_completed THEN
    RAISE EXCEPTION 'Post purge is irreversible' USING ERRCODE = '23514';
  END IF;
  IF NEW.availability IS DISTINCT FROM OLD.availability
     AND NEW.security_revision <= OLD.security_revision THEN
    RAISE EXCEPTION 'Post availability requires an increasing security revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


-- migrate:down
-- Forward only: account erasure cannot restore revision bodies.
