-- migrate:up
ALTER TABLE content.post
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN purge_started_at timestamptz,
  ADD COLUMN purge_completed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT post_deletion_state CHECK (deleted_at IS NULL OR availability = 'erased'),
  ADD CONSTRAINT post_purge_state CHECK ((purge_started_at IS NULL OR availability = 'erased')
    AND (NOT purge_completed OR purge_started_at IS NOT NULL));

CREATE INDEX post_deleted_page_idx ON content.post (route, deleted_at, post_id)
  WHERE deleted_at IS NOT NULL AND NOT purge_completed;

CREATE OR REPLACE FUNCTION content.guard_post_erasure() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
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

CREATE OR REPLACE FUNCTION content.guard_review_thread() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD.review_live AND NEW.review_live AND NOT EXISTS (
    SELECT 1 FROM content.post p WHERE p.route = NEW.route AND p.post_id = NEW.first_post_id
      AND p.availability = 'available' AND p.purge_started_at IS NULL
      AND p.visibility <> 'taken_down' AND NEW.availability = 'available' AND NEW.visibility <> 'taken_down'
  ) THEN
    RAISE EXCEPTION 'A removed review cannot become live again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down
-- Forward only: deletion and purge facts must survive.
