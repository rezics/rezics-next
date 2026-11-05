-- migrate:up
ALTER TABLE community.realm_membership_operation
  DROP CONSTRAINT realm_membership_operation_actor_scopes_check,
  ADD CONSTRAINT realm_membership_operation_actor_scopes_check CHECK (
    cardinality(actor_scopes) <= 512
    AND (cardinality(actor_scopes) = 0 OR array_ndims(actor_scopes) = 1));

-- migrate:down
-- Forward only: retained snapshots may exceed the previous bound.
