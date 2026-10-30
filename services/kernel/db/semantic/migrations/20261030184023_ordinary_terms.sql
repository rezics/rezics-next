-- migrate:up
-- Revision explanation locates the existing editorial record, never its Subject's history.
CREATE INDEX candidate_revision_detail ON semantic.candidate(route,subject_id,revision);
CREATE INDEX acceptance_revision_detail ON semantic.acceptance(route,subject_id,revision);
CREATE INDEX adoption_revision_detail ON semantic.adoption(route,subject_id,revision);

-- migrate:down
DROP INDEX semantic.adoption_revision_detail;
DROP INDEX semantic.acceptance_revision_detail;
DROP INDEX semantic.candidate_revision_detail;
