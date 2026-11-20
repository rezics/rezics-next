-- migrate:up
ALTER TABLE library.collection_source_output_member ADD COLUMN original_subject_id uuid;

-- migrate:down
ALTER TABLE library.collection_source_output_member DROP COLUMN original_subject_id;
