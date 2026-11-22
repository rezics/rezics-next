-- migrate:up
-- Start with the keyed manifest and keep the acknowledgement joins out of
-- callers' plans when binding or disclosing a page against published coverage.
ALTER FUNCTION semantic.public_filter_ack_origin(text, uuid) SET join_collapse_limit = 1;

-- migrate:down
ALTER FUNCTION semantic.public_filter_ack_origin(text, uuid) RESET join_collapse_limit;
