-- Retain exact review text for governance evidence. A deleted head retains its
-- earlier snapshots; principal erasure cascades both head and snapshots.
CREATE TABLE access.reader_review_revision (
  review_id uuid NOT NULL REFERENCES access.reader_review(id) ON DELETE CASCADE,
  revision uuid NOT NULL,
  acting_subject text NOT NULL,
  rating_observation text NOT NULL,
  rating_revision text NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 10),
  language text NOT NULL,
  body text NOT NULL,
  spoiler boolean NOT NULL,
  started_on date,
  finished_on date,
  deleted boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (review_id, revision)
);
INSERT INTO access.reader_review_revision (review_id, revision, acting_subject,
  rating_observation, rating_revision, rating, language, body, spoiler,
  started_on, finished_on, deleted, recorded_at)
SELECT id, revision, acting_subject, rating_observation, rating_revision,
  rating, language, body, spoiler, started_on, finished_on, deleted, updated_at
FROM access.reader_review;
CREATE FUNCTION access.reader_review_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'review revision is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER reader_review_revision_immutable BEFORE UPDATE ON access.reader_review_revision
  FOR EACH ROW EXECUTE FUNCTION access.reader_review_revision_immutable();

-- Preserve all prior owner values when widening the shared governance checks.
ALTER TABLE access.governance_case DROP CONSTRAINT governance_case_target_owner_check;
ALTER TABLE access.governance_case ADD CONSTRAINT governance_case_target_owner_check
  CHECK (target_owner IN ('graph', 'content', 'source', 'media', 'review'));
ALTER TABLE access.governance_evidence DROP CONSTRAINT governance_evidence_owner_check;
ALTER TABLE access.governance_evidence ADD CONSTRAINT governance_evidence_owner_check
  CHECK (owner IN ('graph', 'content', 'source', 'media', 'review'));
ALTER TABLE access.moderation_decision_target DROP CONSTRAINT moderation_decision_target_owner_check;
ALTER TABLE access.moderation_decision_target ADD CONSTRAINT moderation_decision_target_owner_check
  CHECK (owner IN ('graph', 'content', 'source', 'media', 'review'));
ALTER TABLE access.governance_enforcement DROP CONSTRAINT governance_enforcement_owner_check;
ALTER TABLE access.governance_enforcement ADD CONSTRAINT governance_enforcement_owner_check
  CHECK (owner IN ('graph', 'content', 'source', 'media', 'review'));

CREATE INDEX reader_review_enforcement_read ON access.governance_enforcement (resource, revision)
  WHERE owner = 'review' AND component = 'body' AND state = 'restricted'
    AND effect IN ('disclosure', 'publication');
