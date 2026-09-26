-- Export is Content-owned. The Access admission is sealed from this exact
-- Content receipt position, not from a fabricated graph position.
INSERT INTO content.receipt_action (action) VALUES ('export.create') ON CONFLICT DO NOTHING;

ALTER TABLE export.manifest
  ADD COLUMN data_epoch uuid,
  ADD COLUMN sequence bigint,
  ADD COLUMN payload jsonb,
  ADD CONSTRAINT manifest_terminal_position_pair
    CHECK ((data_epoch IS NULL) = (sequence IS NULL)),
  ADD CONSTRAINT manifest_terminal_receipt
    FOREIGN KEY (data_epoch, sequence) REFERENCES content.receipt(data_epoch, sequence),
  ADD CONSTRAINT manifest_payload_object
    CHECK (payload IS NULL OR (jsonb_typeof(payload) = 'object'
      AND octet_length(payload::text) <= 1048576));
CREATE UNIQUE INDEX manifest_terminal_position_idx ON export.manifest (data_epoch, sequence)
  WHERE data_epoch IS NOT NULL;
