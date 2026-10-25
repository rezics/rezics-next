-- migrate:up
-- Deployment-only backfill and index construction: these may visit deployed rows
-- once, offline. No request or erasure job derives creation keys from history.
-- Prefer the entity's original transaction metadata, then the earliest available
-- revision for its post/thread. Boards without transaction metadata and entities
-- without either source use this migration transaction's single timestamp.
DROP TRIGGER board_identity ON content.board;
DROP TRIGGER thread_identity ON content.thread;
DROP TRIGGER post_identity ON content.post;

ALTER TABLE content.board DROP CONSTRAINT board_visibility_check;
ALTER TABLE content.thread DROP CONSTRAINT thread_visibility_check;
ALTER TABLE content.post DROP CONSTRAINT post_visibility_check;
UPDATE content.board SET visibility = CASE visibility WHEN 'public' THEN 'published' ELSE 'protected' END
  WHERE visibility IN ('public', 'private');
UPDATE content.thread SET visibility = CASE visibility WHEN 'public' THEN 'published' ELSE 'protected' END
  WHERE visibility IN ('public', 'private');
UPDATE content.post SET visibility = CASE visibility WHEN 'public' THEN 'published' ELSE 'protected' END
  WHERE visibility IN ('public', 'private');
ALTER TABLE content.board ADD CONSTRAINT board_visibility_check
  CHECK (visibility IN ('published', 'draft', 'protected', 'taken_down'));
ALTER TABLE content.thread ADD CONSTRAINT thread_visibility_check
  CHECK (visibility IN ('published', 'draft', 'protected', 'taken_down'));
ALTER TABLE content.post ADD CONSTRAINT post_visibility_check
  CHECK (visibility IN ('published', 'draft', 'protected', 'taken_down'));

ALTER TABLE content.board ADD COLUMN created_at timestamptz;
ALTER TABLE content.thread ADD COLUMN created_at timestamptz;
ALTER TABLE content.post ADD COLUMN created_at timestamptz;
UPDATE content.board b SET created_at = COALESCE(
  (SELECT recorded_at FROM editorial.write_basis w
   WHERE w.partition_no = b.route >> 4 AND w.transaction_id = b.recorded_transaction_id), transaction_timestamp());
WITH earliest AS (
  SELECT route, thread_id, min(recorded_at) AS recorded_at FROM content.revision GROUP BY route, thread_id
)
UPDATE content.thread t SET created_at = COALESCE(w.recorded_at, r.recorded_at, transaction_timestamp())
FROM content.thread original
LEFT JOIN editorial.write_basis w
  ON w.partition_no = original.route >> 4 AND w.transaction_id = original.recorded_transaction_id
LEFT JOIN earliest r ON r.route = original.route AND r.thread_id = original.thread_id
WHERE t.route = original.route AND t.thread_id = original.thread_id;
WITH earliest AS (
  SELECT route, post_id, min(recorded_at) AS recorded_at FROM content.revision GROUP BY route, post_id
)
UPDATE content.post p SET created_at = COALESCE(w.recorded_at, r.recorded_at, transaction_timestamp())
FROM content.post original
LEFT JOIN editorial.write_basis w
  ON w.partition_no = original.route >> 4 AND w.transaction_id = original.recorded_transaction_id
LEFT JOIN earliest r ON r.route = original.route AND r.post_id = original.post_id
WHERE p.route = original.route AND p.post_id = original.post_id;
-- Defaults support historical fixture writers. Production commands supply their
-- trusted attempt T explicitly; retries must preserve the originally stored key.
ALTER TABLE content.board ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
ALTER TABLE content.thread ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
ALTER TABLE content.post ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
CREATE TRIGGER board_identity BEFORE UPDATE ON content.board
FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'board_id', 'subject_id', 'created_at');
CREATE TRIGGER thread_identity BEFORE UPDATE ON content.thread
FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'thread_id', 'author_account_id', 'created_at');
CREATE TRIGGER post_identity BEFORE UPDATE ON content.post
FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'thread_id', 'post_id', 'reply_to_post_id', 'author_account_id', 'created_at');

-- NULL preserves historical fixtures only, not public create permission. Every
-- production thread create must set this pointer and INSERT its first post in
-- the same transaction. Readers use the pointer, never a latest/head heuristic.
ALTER TABLE content.thread ADD COLUMN first_post_id uuid,
  ADD CONSTRAINT thread_first_post_fk FOREIGN KEY (route, thread_id, first_post_id)
    REFERENCES content.post (route, thread_id, post_id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN availability text NOT NULL DEFAULT 'available'
    CHECK (availability IN ('available', 'erased')),
  ALTER COLUMN title DROP NOT NULL;
ALTER TABLE content.post ADD COLUMN availability text NOT NULL DEFAULT 'available'
  CHECK (availability IN ('available', 'erased'));

-- References stay on each immutable revision; logical post/root erasure carries
-- no body copy and does not change the revision's exact metadata or digest.
CREATE FUNCTION content.media_routes_match(route integer, media_ids uuid[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT COALESCE(bool_and(media_id IS NOT NULL AND
    route = get_byte(uuid_send(media_id), 10) * 256 + get_byte(uuid_send(media_id), 11)), true)
  FROM unnest(media_ids) AS media_id
$$;
ALTER TABLE content.revision ADD COLUMN media_ids uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT revision_subject_ids_limit CHECK (cardinality(subject_ids) <= 128),
  ADD CONSTRAINT revision_media_ids_limit CHECK (cardinality(media_ids) <= 32),
  ADD CONSTRAINT revision_media_routes_check CHECK (content.media_routes_match(route, media_ids));
CREATE OR REPLACE FUNCTION content.guard_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Revision identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.thread_id, NEW.post_id, NEW.revision_id, NEW.body_sha256,
         NEW.licence, NEW.subject_ids, NEW.board_id, NEW.recorded_transaction_id, NEW.recorded_at, NEW.media_ids)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.thread_id, OLD.post_id, OLD.revision_id, OLD.body_sha256,
         OLD.licence, OLD.subject_ids, OLD.board_id, OLD.recorded_transaction_id, OLD.recorded_at, OLD.media_ids)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased'
     OR NEW.body IS NOT NULL OR NEW.search_text IS NOT NULL THEN
    RAISE EXCEPTION 'Revisions are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Runtime consumers seek first/last with LIMIT 1, keyset pages with LIMIT <=100,
-- and exact identities with route + ID. No COUNT, OFFSET or partition sorting.
-- Each column write is constant and index maintenance O(log(Ut)); prefix seeks
-- cost O(log(Ut)+K), K<=100, independently of unrelated authors and histories.
CREATE INDEX post_thread_page_idx ON content.post (route, thread_id, created_at, post_id);
CREATE INDEX revision_post_page_idx ON content.revision (route, post_id, recorded_at, revision_id);
CREATE INDEX post_thread_author_page_idx ON content.post (route, thread_id, author_account_id, created_at, post_id);

-- migrate:down
-- Forward only: stable creation keys and exact revision history survive rollback.
