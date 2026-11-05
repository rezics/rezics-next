-- migrate:up
ALTER TABLE content.board
  ADD COLUMN purpose text NOT NULL DEFAULT 'discussion',
  ADD CONSTRAINT board_purpose_check CHECK (purpose IN ('discussion', 'reviews'));

DROP TRIGGER board_identity ON content.board;
CREATE TRIGGER board_identity BEFORE UPDATE ON content.board
FOR EACH ROW EXECUTE FUNCTION content.guard_identity(
  'route', 'board_id', 'realm_id', 'subject_id', 'created_at', 'purpose'
);

CREATE UNIQUE INDEX board_one_realm_reviews_idx
  ON content.board (route, realm_id)
  WHERE realm_id IS NOT NULL AND purpose = 'reviews';
CREATE UNIQUE INDEX board_one_global_reviews_idx
  ON content.board ((purpose))
  WHERE realm_id IS NULL AND purpose = 'reviews';

ALTER TABLE content.thread
  ADD COLUMN kind text NOT NULL DEFAULT 'discussion',
  ADD COLUMN review_subject_id uuid,
  ADD COLUMN review_live boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT thread_kind_check CHECK (kind IN ('discussion', 'review')),
  ADD CONSTRAINT thread_review_subject_check CHECK (
    (kind = 'review' AND review_subject_id IS NOT NULL)
    OR (kind = 'discussion' AND review_subject_id IS NULL)
  ),
  ADD CONSTRAINT thread_review_route_check CHECK (
    kind <> 'review' OR route = get_byte(uuid_send(board_id), 10) * 256 + get_byte(uuid_send(board_id), 11)
  );

DROP TRIGGER thread_identity ON content.thread;
CREATE TRIGGER thread_identity BEFORE UPDATE ON content.thread
FOR EACH ROW EXECUTE FUNCTION content.guard_identity(
  'route', 'thread_id', 'author_account_id', 'board_id', 'first_post_id', 'kind', 'review_subject_id'
);

CREATE FUNCTION content.guard_review_thread() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  board_purpose text;
BEGIN
  SELECT purpose INTO board_purpose
  FROM content.board
  WHERE route = get_byte(uuid_send(NEW.board_id), 10) * 256 + get_byte(uuid_send(NEW.board_id), 11)
    AND board_id = NEW.board_id;
  IF board_purpose IS NULL OR (board_purpose = 'reviews') IS DISTINCT FROM (NEW.kind = 'review') THEN
    RAISE EXCEPTION 'Thread kind must match its board purpose' USING ERRCODE = '23514';
  END IF;
  IF OLD.review_live IS FALSE AND NEW.review_live IS TRUE THEN
    RAISE EXCEPTION 'A removed review cannot become live again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER thread_review_board BEFORE INSERT OR UPDATE ON content.thread
FOR EACH ROW EXECUTE FUNCTION content.guard_review_thread();

CREATE UNIQUE INDEX thread_one_live_review_idx
  ON content.thread (route, board_id, author_account_id, review_subject_id)
  WHERE kind = 'review' AND review_live AND availability = 'available' AND visibility <> 'taken_down';

ALTER TABLE content.revision
  ADD COLUMN vote_citation jsonb,
  ADD CONSTRAINT revision_vote_citation_check CHECK (
    vote_citation IS NULL OR (
      jsonb_typeof(vote_citation) = 'object'
      AND vote_citation ?& ARRAY['questionId', 'units', 'revision']
      AND vote_citation - ARRAY['questionId', 'units', 'revision'] = '{}'::jsonb
      AND jsonb_typeof(vote_citation -> 'questionId') = 'string'
      AND vote_citation ->> 'questionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(vote_citation -> 'units') = 'number'
      AND (vote_citation ->> 'units') ~ '^(0|[1-9][0-9]*)$'
      AND (vote_citation ->> 'units')::numeric BETWEEN 0 AND 20
      AND jsonb_typeof(vote_citation -> 'revision') = 'number'
      AND (vote_citation ->> 'revision') ~ '^[1-9][0-9]*$'
      AND (vote_citation ->> 'revision')::numeric <= 2147483647
    )
  );

CREATE FUNCTION content.guard_review_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  thread_kind text;
  first_post_id uuid;
  review_subject_id uuid;
BEGIN
  SELECT t.kind, t.first_post_id, t.review_subject_id
    INTO thread_kind, first_post_id, review_subject_id
  FROM content.thread t
  WHERE t.route = NEW.route AND t.thread_id = NEW.thread_id;

  IF thread_kind IS NULL THEN
    RAISE EXCEPTION 'Revision thread is missing' USING ERRCODE = '23503';
  END IF;
  IF thread_kind = 'review' THEN
    IF NEW.post_id = first_post_id AND NEW.subject_ids IS DISTINCT FROM ARRAY[review_subject_id]::uuid[] THEN
      RAISE EXCEPTION 'A review revision must retain exactly its target subject' USING ERRCODE = '23514';
    END IF;
    IF NEW.post_id <> first_post_id AND NEW.vote_citation IS NOT NULL THEN
      RAISE EXCEPTION 'Only a review first post may cite a vote' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.vote_citation IS NOT NULL THEN
    RAISE EXCEPTION 'Only a review may cite a vote' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_review_contract BEFORE INSERT ON content.revision
FOR EACH ROW EXECUTE FUNCTION content.guard_review_revision();

CREATE OR REPLACE FUNCTION content.guard_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
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
         AND p.availability = 'erased'
     ) THEN
    RAISE EXCEPTION 'Revisions are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- The site-wide board is the single Global place for reviews.
INSERT INTO content.board
  (route, board_id, realm_id, subject_id, title, visibility, security_revision,
   recorded_transaction_id, created_at, purpose)
VALUES
  (0, '00000000-0000-8000-8000-000000000001', NULL,
   '00000000-0000-8000-8000-000000000000', 'Global reviews', 'published', 1,
   '00000000-0000-8000-8000-000000000001', '2026-10-27T00:00:00Z', 'reviews');

-- migrate:down
-- Forward only: reviews, their board placement, and immutable vote citations must survive rollback.
