-- migrate:up
ALTER TABLE content.account_erasure_progress DROP CONSTRAINT account_erasure_progress_phase_check;
ALTER TABLE content.account_erasure_progress
  ADD CONSTRAINT account_erasure_progress_phase_check
  CHECK (phase IN ('slow-mode','authored','knowledge','uploads','reactions','moderation','notices','proof','complete'));

-- migrate:down
-- Forward only: removing a pending Knowledge phase could skip required account cleanup.
