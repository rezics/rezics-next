-- migrate:up
ALTER TABLE search.identity_writer ADD COLUMN relay_receipt text;
ALTER TABLE search.identity_writer ADD CONSTRAINT identity_writer_relay_receipt_check
  CHECK (relay_receipt IS NULL OR
    (dispatch_state='dispatched' AND writer_token IS NOT NULL AND octet_length(relay_receipt)<=8192));

-- migrate:down
ALTER TABLE search.identity_writer DROP COLUMN relay_receipt;
