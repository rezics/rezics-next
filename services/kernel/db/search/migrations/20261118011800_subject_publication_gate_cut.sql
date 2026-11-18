-- migrate:up
-- Latest contiguous (from, through] run of Subject publication gate commands at home zero.
ALTER TABLE search.identity_writer_gate
  ADD COLUMN publication_gate_from bigint,
  ADD COLUMN publication_gate_through bigint;
CREATE INDEX identity_writer_publication_gate_cut
  ON search.identity_writer_gate (owner_epoch,publication_gate_through)
  WHERE partition_no=0 AND publication_gate_through IS NOT NULL;

-- migrate:down
DROP INDEX search.identity_writer_publication_gate_cut;
ALTER TABLE search.identity_writer_gate
  DROP COLUMN publication_gate_from,
  DROP COLUMN publication_gate_through;
