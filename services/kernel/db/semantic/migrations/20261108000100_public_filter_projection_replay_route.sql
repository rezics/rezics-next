-- migrate:up
-- The replay row is owned by the root Source bootstrap, while route identifies
-- the subject being replayed and may belong to any of the 4096 native homes.
-- Requiring the subject route to share the bootstrap's root partition rejects
-- valid cross-home subjects.
ALTER TABLE semantic.public_filter_projection_replay
  DROP CONSTRAINT public_filter_projection_replay_check;

-- migrate:down
ALTER TABLE semantic.public_filter_projection_replay
  ADD CONSTRAINT public_filter_projection_replay_check
  CHECK (route >= partition_no * 16 AND route < (partition_no + 1) * 16) NOT VALID;
