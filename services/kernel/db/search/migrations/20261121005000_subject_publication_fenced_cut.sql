-- migrate:up
ALTER TABLE search.generation_publication ADD COLUMN subject_fenced_cut bytea
  CHECK (octet_length(subject_fenced_cut)=32);

-- migrate:down
ALTER TABLE search.generation_publication DROP COLUMN subject_fenced_cut;
