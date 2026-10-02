-- Topic-scoped ranking, including the zero-score tail, seeks existing term
-- membership without pulling global ranking pages into the application.
CREATE INDEX IF NOT EXISTS discovery_concept_membership
  ON access.discovery_term_count (generation_id, concept, term)
  WHERE concept IS NOT NULL;
CREATE INDEX IF NOT EXISTS discovery_topic_work
  ON access.discovery_entry (generation_id, work, term)
  WHERE work_type = '';
