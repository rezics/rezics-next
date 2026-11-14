-- migrate:up
ALTER TABLE library.hosted_reading
  ADD COLUMN body_language text,
  ADD COLUMN target_post_id uuid,
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

DO $$
DECLARE
  checkpoint library.hosted_reading%ROWTYPE;
  selected_post uuid;
  batch_count integer;
  last_route integer := -1;
  last_account uuid := '00000000-0000-0000-0000-000000000000';
  last_subject uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  LOOP
    batch_count := 0;
    FOR checkpoint IN
      SELECT * FROM library.hosted_reading
      WHERE (route, account_id, subject_id) > (last_route, last_account, last_subject)
      ORDER BY route, account_id, subject_id LIMIT 100
    LOOP
      -- The occurrence's canonical Post is immutable. Validate its exact saved revision and digest.
      SELECT occurrence.post_id INTO selected_post
      FROM content.hosted_occurrence occurrence
      JOIN content.revision revision
        ON revision.route = get_byte(uuid_send(checkpoint.target_revision_id), 10) * 256
                              + get_byte(uuid_send(checkpoint.target_revision_id), 11)
       AND revision.revision_id = checkpoint.target_revision_id
       AND revision.post_id = occurrence.post_id AND revision.thread_id = occurrence.thread_id
       AND revision.body_sha256 = checkpoint.target_sha256
      WHERE occurrence.route = get_byte(uuid_send(checkpoint.catalogue_id), 10) * 256
                                   + get_byte(uuid_send(checkpoint.catalogue_id), 11)
        AND occurrence.catalogue_id = checkpoint.catalogue_id
        AND occurrence.occurrence_id = checkpoint.occurrence_id AND occurrence.kind = 'chapter';
      IF selected_post IS NULL THEN
        INSERT INTO library.hosted_reading_unsupported(route, account_id, subject_id, evidence, reason)
        VALUES (checkpoint.route, checkpoint.account_id, checkpoint.subject_id,
                to_jsonb(checkpoint), 'exact_target_unavailable');
        DELETE FROM library.hosted_reading
        WHERE (route, account_id, subject_id) = (checkpoint.route, checkpoint.account_id, checkpoint.subject_id);
      ELSE
        UPDATE library.hosted_reading SET target_post_id = selected_post
        WHERE (route, account_id, subject_id) = (checkpoint.route, checkpoint.account_id, checkpoint.subject_id);
      END IF;
      last_route := checkpoint.route;
      last_account := checkpoint.account_id;
      last_subject := checkpoint.subject_id;
      batch_count := batch_count + 1;
    END LOOP;
    EXIT WHEN batch_count = 0;
  END LOOP;
END; $$;

ALTER TABLE library.hosted_reading ALTER COLUMN target_post_id SET NOT NULL;

DROP INDEX library.hosted_reading_activity_idx;
CREATE INDEX hosted_reading_activity_idx
  ON library.hosted_reading (route, account_id, activity_sequence DESC, subject_id)
  INCLUDE (changed_at, revision, catalogue_id, publication_revision_id, occurrence_id,
           body_language, target_post_id, target_revision_id, target_sha256, document_block_id, document_offset);

-- migrate:down
DROP TRIGGER native_source_writer ON library.hosted_reading;
ALTER TABLE library.hosted_reading ALTER COLUMN target_post_id DROP NOT NULL;
-- A conflicting newer canonical checkpoint refuses downgrade rather than discarding retained evidence.
INSERT INTO library.hosted_reading
  (route, account_id, subject_id, catalogue_id, publication_revision_id, occurrence_id,
   target_revision_id, target_sha256, document_block_id, document_offset, revision, changed_at, activity_sequence)
SELECT old.route, old.account_id, old.subject_id, old.catalogue_id, old.publication_revision_id, old.occurrence_id,
       old.target_revision_id, old.target_sha256, old.document_block_id, old.document_offset,
       old.revision, old.changed_at, old.activity_sequence
FROM library.hosted_reading_unsupported retained
CROSS JOIN LATERAL jsonb_populate_record(NULL::library.hosted_reading, retained.evidence) old;
DROP TABLE library.hosted_reading_unsupported;
DROP INDEX library.hosted_reading_activity_idx;
CREATE INDEX hosted_reading_activity_idx
  ON library.hosted_reading (route, account_id, activity_sequence DESC, subject_id)
  INCLUDE (changed_at, revision, catalogue_id, publication_revision_id, occurrence_id,
           target_revision_id, target_sha256, document_block_id, document_offset);
ALTER TABLE library.hosted_reading DROP COLUMN body_language, DROP COLUMN target_post_id;
