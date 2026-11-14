-- migrate:up
ALTER TABLE library.hosted_reading
  ADD COLUMN body_language text,
  ADD CONSTRAINT hosted_reading_body_language_check
    CHECK (body_language IS NULL OR
      (char_length(body_language) BETWEEN 1 AND 63 AND body_language ~ '^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$'));

CREATE TRIGGER native_source_writer AFTER INSERT OR UPDATE OR DELETE ON library.hosted_reading
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();

-- Earlier development addresses did not retain their immutable Post identity.
-- Preserve unresolved evidence outside the canonical reader, under its existing erasure fence.
CREATE TABLE library.hosted_reading_unsupported (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  evidence jsonb NOT NULL,
  reason text NOT NULL CHECK (reason = 'exact_target_unavailable'),
  PRIMARY KEY (route, account_id, subject_id),
  FOREIGN KEY (route, account_id, subject_id)
    REFERENCES library.hosted_reading_fence(route, account_id, subject_id) ON DELETE CASCADE
);

DROP INDEX library.hosted_reading_activity_idx;
CREATE INDEX hosted_reading_activity_idx
  ON library.hosted_reading (route, account_id, activity_sequence DESC, subject_id)
  INCLUDE (changed_at, revision, catalogue_id, publication_revision_id, occurrence_id,
           body_language, target_post_id, target_revision_id, target_sha256, document_block_id, document_offset);

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM library.hosted_reading_unsupported LIMIT 1)
     OR EXISTS (SELECT 1 FROM library.hosted_reading WHERE body_language IS NOT NULL LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot remove retained hosted reading language or unsupported evidence' USING ERRCODE='23514';
  END IF;
END;
$$;
DROP TRIGGER native_source_writer ON library.hosted_reading;
DROP TABLE library.hosted_reading_unsupported;
DROP INDEX library.hosted_reading_activity_idx;
CREATE INDEX hosted_reading_activity_idx
  ON library.hosted_reading (route, account_id, activity_sequence DESC, subject_id)
  INCLUDE (changed_at, revision, catalogue_id, publication_revision_id, occurrence_id,
           target_post_id, target_revision_id, target_sha256, document_block_id, document_offset);
ALTER TABLE library.hosted_reading DROP COLUMN body_language;
