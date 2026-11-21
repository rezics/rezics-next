-- migrate:up
-- Only an engine rejection before bulk admission retains a replayable original action.
ALTER TABLE search.identity_writer ADD COLUMN relay_rejected_action text,
  ADD CONSTRAINT identity_writer_rejected_action_check CHECK (
    relay_rejected_action IS NULL OR (dispatch_state='dispatched' AND writer_token IS NOT NULL
      AND relay_intent IS NOT NULL AND relay_receipt IS NULL));

-- migrate:down
-- Keep rejected originals recoverable until their writer has consumed them.
ALTER TABLE search.identity_writer ADD CHECK (relay_rejected_action IS NULL);
ALTER TABLE search.identity_writer DROP COLUMN relay_rejected_action;
