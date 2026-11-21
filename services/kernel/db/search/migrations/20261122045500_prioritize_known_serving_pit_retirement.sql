-- migrate:up
CREATE INDEX public_filter_pit_claim_physical_due ON search.public_filter_pit_claim (target_prefix, retry_after, partition_no, bootstrap) WHERE state IN ('retained','handed','closing');

-- migrate:down
DROP INDEX search.public_filter_pit_claim_physical_due;
