-- migrate:up
-- An analyzed 64-row table favors a sequential scan. Its relation-wide
-- SERIALIZABLE read predicate makes writers to different shards conflict.
-- This trigger's only query updates one existing shard by its primary key.
ALTER FUNCTION semantic.update_identity_basis_shard() SET enable_seqscan TO off;

-- migrate:down
ALTER FUNCTION semantic.update_identity_basis_shard() RESET enable_seqscan;
