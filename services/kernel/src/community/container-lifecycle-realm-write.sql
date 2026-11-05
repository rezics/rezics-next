WITH input AS NOT MATERIALIZED (SELECT :state::text AS state)
UPDATE community.realm h
SET state = i.state, lifecycle_version = lifecycle_version + 1,
    removed_at = CASE WHEN i.state = 'removed' THEN :at::timestamptz ELSE removed_at END,
    removed_by = CASE WHEN i.state = 'removed' THEN :actor::uuid ELSE removed_by END,
    remover_role = CASE WHEN i.state = 'removed' THEN :role::text ELSE remover_role END,
    removal_reason = CASE WHEN i.state = 'removed' THEN :reason::text ELSE removal_reason END
FROM input i
WHERE route=:route::integer AND realm_id=:id::uuid
  AND head_revision_id=:head::uuid AND lifecycle_version=:version::bigint
  AND h.state <> i.state
RETURNING lifecycle_version::text;
