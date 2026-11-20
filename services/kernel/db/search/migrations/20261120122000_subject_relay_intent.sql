-- migrate:up
ALTER TABLE search.identity_writer ADD COLUMN relay_intent text;
ALTER TABLE search.identity_writer ADD CONSTRAINT identity_writer_relay_intent_check
  CHECK (relay_intent IS NULL OR
    (dispatch_state='dispatched' AND writer_token IS NOT NULL AND octet_length(relay_intent)<=82));

-- migrate:down
ALTER TABLE search.identity_writer DROP COLUMN relay_intent;
