-- migrate:up
-- The page contains exact keys. Small or freshly populated tables otherwise favor
-- a sequential scan for each LATERAL lookup. Scope the plan to this function.
CREATE FUNCTION semantic.identity_epoch_mapping_sources(originals uuid[], routes integer[])
RETURNS TABLE(subject_id uuid, mapping semantic.identity_epoch_mapping,
              dirty_revision bigint, captured_revision bigint, current_target uuid)
LANGUAGE sql STABLE SET enable_seqscan = off AS $$
  SELECT s.subject_id,m.mapping,coalesce(d.revision,0),coalesce(d.captured_revision,0),r.target
  FROM unnest(originals,routes) requested(original,route)
  JOIN LATERAL (
    SELECT s.subject_id,s.route FROM semantic.subject s
    WHERE (s.route,s.subject_id)=(requested.route,requested.original) LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT m AS mapping FROM semantic.identity_epoch_mapping m
    WHERE (m.route,m.original)=(s.route,s.subject_id) LIMIT 1
  ) m ON true
  LEFT JOIN LATERAL (
    SELECT d.revision,d.captured_revision FROM semantic.identity_epoch_dirty d
    WHERE (d.route,d.original)=(s.route,s.subject_id) LIMIT 1
  ) d ON true
  LEFT JOIN LATERAL (
    SELECT r.target FROM semantic.redirect r WHERE (r.route,r.subject_id)=(s.route,s.subject_id)
    ORDER BY r.sequence DESC LIMIT 1
  ) r ON true
$$;

CREATE FUNCTION semantic.identity_epoch_pending_groups(partitions integer[], terminals uuid[])
RETURNS TABLE(partition_no integer, terminal uuid, pending_job uuid, pending_epoch bigint)
LANGUAGE sql STABLE SET enable_seqscan = off AS $$
  SELECT g.partition_no,g.terminal,g.pending_job,g.pending_epoch
  FROM unnest(partitions,terminals) requested(partition_no,terminal)
  JOIN LATERAL (
    SELECT g.partition_no,g.terminal,g.pending_job,g.pending_epoch FROM semantic.identity_epoch_group g
    WHERE (g.partition_no,g.terminal)=(requested.partition_no,requested.terminal) LIMIT 1
  ) g ON true
$$;

CREATE FUNCTION semantic.identity_epoch_group_points(partitions integer[], terminals uuid[], originals uuid[])
RETURNS TABLE(partition_no integer, terminal uuid, published_epoch bigint, owner_epoch integer, generation uuid,
              closure_state text, closure_incarnation uuid, requested_original uuid,
              directory_state text, directory_enrollment uuid, directory_incarnation uuid, directory_install uuid,
              directory_export uuid, directory_revision bigint, directory_owner integer, registration_transaction uuid,
              redirected boolean, pending_job uuid, pending_epoch bigint)
LANGUAGE sql STABLE SET enable_seqscan = off AS $$
  SELECT g.partition_no,g.terminal,g.published_epoch,g.owner_epoch,g.generation,
    g.closure_state,g.closure_incarnation,requested.original,
    o.closure_state,o.closure_enrollment,o.closure_incarnation,o.closure_install_transaction,
    o.closure_export_transaction,o.closure_source_revision,o.closure_source_epoch,
    n.transaction_id,r.target IS NOT NULL,g.pending_job,g.pending_epoch
  FROM unnest(partitions,terminals,originals) requested(partition_no,terminal,original)
  JOIN LATERAL (
    SELECT g.* FROM semantic.identity_epoch_group g
    WHERE (g.partition_no,g.terminal)=(requested.partition_no,requested.terminal) LIMIT 1
  ) g ON true
  LEFT JOIN LATERAL (
    SELECT o.* FROM semantic.identity_epoch_original o
    WHERE (o.partition_no,o.generation,o.original)=(g.partition_no,g.generation,requested.original) LIMIT 1
  ) o ON true
  LEFT JOIN LATERAL (
    SELECT n.transaction_id FROM semantic.identity_epoch_native_commit n
    WHERE (n.partition_no,n.transaction_id)=(o.partition_no,o.closure_registration_transaction)
      AND n.xmin::text=o.closure_registration_xid LIMIT 1
  ) n ON true
  LEFT JOIN LATERAL (
    SELECT r.target FROM semantic.redirect r
    WHERE r.subject_id=g.terminal
      AND r.route=get_byte(uuid_send(g.terminal),10)*256+get_byte(uuid_send(g.terminal),11)
    ORDER BY r.sequence DESC LIMIT 1
  ) r ON true
$$;

-- migrate:down
DROP FUNCTION semantic.identity_epoch_group_points(integer[],uuid[],uuid[]);
DROP FUNCTION semantic.identity_epoch_pending_groups(integer[],uuid[]);
DROP FUNCTION semantic.identity_epoch_mapping_sources(uuid[],integer[]);
