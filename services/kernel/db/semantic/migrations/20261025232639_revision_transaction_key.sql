-- migrate:up
DROP INDEX semantic.revision_transaction;
CREATE INDEX revision_transaction ON semantic.revision (recorded_transaction_id, route, subject_id);

-- migrate:down
DROP INDEX semantic.revision_transaction;
CREATE INDEX revision_transaction ON semantic.revision (route, subject_id, recorded_transaction_id);
