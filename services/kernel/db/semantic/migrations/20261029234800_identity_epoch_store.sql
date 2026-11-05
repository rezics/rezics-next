-- migrate:up
-- A group basis is scoped by terminal even for historical tokens shared by a native transaction.
CREATE INDEX identity_epoch_scoped_generation_original ON semantic.identity_epoch_original(generation,terminal,original)
 WHERE present;

-- migrate:down
-- Forward-only native scoped immutable input lookup.
