WITH parameters AS (SELECT $1::integer p1,$2::uuid p2), originals AS (
  SELECT * FROM jsonb_to_recordset($5::jsonb) AS x(input_original uuid,source_route integer,
    partition_no integer,terminal uuid,generation uuid,version bigint,observed_count bigint,
    source_revision bigint,source_transaction_id uuid,owner_epoch integer,source_owner_epoch integer)
)
SELECT j.intent,j.receipt,j.state,n.epoch AS native_epoch,n.position::text AS native_position,
  n.transaction_id,p.node AS owner_node,c.published_epoch::text,c.pending_job,
  NOT EXISTS (
    SELECT 1 FROM originals x
    LEFT JOIN semantic.identity_epoch_admission_source s
      ON (s.partition_no,s.job_id,s.original)=((SELECT p1 FROM parameters),(SELECT p2 FROM parameters),x.input_original)
    LEFT JOIN semantic.identity_epoch_input i ON (i.partition_no,i.job_id,i.terminal)=
      ((SELECT p1 FROM parameters),(SELECT p2 FROM parameters),x.terminal)
    WHERE s.original IS NULL OR i.terminal IS NULL
      OR (s.route,s.control_partition,s.terminal,s.generation,s.basis_version,s.source_revision,
          s.source_transaction_id,s.owner_epoch,s.source_owner_epoch) IS DISTINCT FROM
         (x.source_route,x.partition_no,x.terminal,x.generation,x.version,x.source_revision,
          x.source_transaction_id,x.owner_epoch,x.source_owner_epoch)
      OR (i.generation,i.basis_version,i.original_count,i.control_partition,i.owner_epoch) IS DISTINCT FROM
         (x.generation,x.version,x.observed_count,x.partition_no,x.owner_epoch)
  ) AND (SELECT count(*) FROM (
    SELECT 1 FROM semantic.identity_epoch_admission_source
    WHERE partition_no=(SELECT p1 FROM parameters) AND job_id=(SELECT p2 FROM parameters) LIMIT 3
  ) retained_sources)=(SELECT count(*) FROM originals)
  AND (SELECT count(*) FROM (
    SELECT 1 FROM semantic.identity_epoch_input
    WHERE partition_no=(SELECT p1 FROM parameters) AND job_id=(SELECT p2 FROM parameters) LIMIT 3
  ) retained_inputs)=(SELECT count(DISTINCT terminal) FROM originals) AS inputs_match
FROM semantic.identity_epoch_job j
JOIN semantic.identity_epoch_native_commit n
  ON (n.partition_no,n.transaction_id)=(j.partition_no,j.recorded_transaction_id) AND n.purpose='admission'
JOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active'
  AND p.epoch=n.epoch AND p.position>=n.position AND n.position>0
JOIN semantic.identity_epoch_control c ON c.partition_no=j.partition_no
WHERE j.partition_no=(SELECT p1 FROM parameters) AND j.job_id=(SELECT p2 FROM parameters)
  AND j.epoch=$3 AND j.scope_digest=$4
  AND j.state IN ('pending','published');
