-- migrate:up
-- Stable private checkpoint chronology. Every successful save advances its activity key;
-- exact command receipt retries do not execute this mutation again.
CREATE SEQUENCE library.hosted_reading_activity_sequence AS bigint;

ALTER TABLE library.hosted_reading
  ADD COLUMN activity_sequence bigint;

-- Preserve the established last-change ordering while creating an indexed key
-- for future mutations. Equal timestamps keep Subject ID as the page tie-break.
WITH chronology AS (
  SELECT route,
         account_id,
         subject_id,
         dense_rank() OVER (ORDER BY changed_at ASC)::bigint AS activity_sequence
  FROM library.hosted_reading
)
UPDATE library.hosted_reading AS stored
SET activity_sequence = chronology.activity_sequence
FROM chronology
WHERE stored.route = chronology.route
  AND stored.account_id = chronology.account_id
  AND stored.subject_id = chronology.subject_id;

SELECT setval(
  'library.hosted_reading_activity_sequence',
  COALESCE(MAX(activity_sequence), 1),
  MAX(activity_sequence) IS NOT NULL
)
FROM library.hosted_reading;

ALTER TABLE library.hosted_reading
  ALTER COLUMN activity_sequence SET DEFAULT nextval('library.hosted_reading_activity_sequence'),
  ALTER COLUMN activity_sequence SET NOT NULL;

ALTER SEQUENCE library.hosted_reading_activity_sequence
  OWNED BY library.hosted_reading.activity_sequence;

CREATE INDEX hosted_reading_activity_idx
  ON library.hosted_reading (route, account_id, activity_sequence DESC, subject_id ASC)
  INCLUDE (
    changed_at,
    revision,
    catalogue_id,
    publication_revision_id,
    occurrence_id,
    target_revision_id,
    target_sha256,
    document_block_id,
    document_offset
  );

-- migrate:down
DROP INDEX library.hosted_reading_activity_idx;
ALTER SEQUENCE library.hosted_reading_activity_sequence OWNED BY NONE;
ALTER TABLE library.hosted_reading DROP COLUMN activity_sequence;
DROP SEQUENCE library.hosted_reading_activity_sequence;
