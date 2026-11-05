-- migrate:up
ALTER TABLE search.public_filter_coverage_home
  ADD COLUMN acknowledged_observation text CHECK (octet_length(acknowledged_observation) BETWEEN 1 AND 4096),
  ADD COLUMN acknowledged_execution text CHECK (octet_length(acknowledged_execution) BETWEEN 1 AND 4096),
  ADD COLUMN acknowledged_settlement text CHECK (octet_length(acknowledged_settlement) BETWEEN 1 AND 4096),
  ADD CONSTRAINT public_filter_coverage_ack_receipt CHECK
    ((acknowledged_observation IS NULL)=(acknowledged_execution IS NULL) AND
     (acknowledged_execution IS NULL)=(acknowledged_settlement IS NULL) AND
     (acknowledged_settlement IS NULL OR acknowledged_baseline IS NOT NULL));

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Native coverage ACK receipts require consumer retirement';
END $$;
