-- migrate:up
ALTER TABLE library.entry_personal_fact
  ADD COLUMN applied_subject_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD CONSTRAINT entry_personal_fact_applied_subject_ids_limit
    CHECK (cardinality(applied_subject_ids) <= 32 AND array_position(applied_subject_ids, NULL::uuid) IS NULL);

-- migrate:down
ALTER TABLE library.entry_personal_fact DROP COLUMN applied_subject_ids;
