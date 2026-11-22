-- migrate:up
-- Keep the keyed manifest's explicit join order within the committed proof.
-- The origin proof has its own migration and rollback boundary.
ALTER FUNCTION semantic.public_filter_committed_ack(uuid, text, uuid, text) SET join_collapse_limit = 1;

-- migrate:down
ALTER FUNCTION semantic.public_filter_committed_ack(uuid, text, uuid, text) RESET join_collapse_limit;
