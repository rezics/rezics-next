WITH parameters AS (SELECT $1::integer AS home, $2::jsonb AS sources),
requested AS MATERIALIZED (
  SELECT route, original, terminal, source_revision
  FROM parameters, jsonb_to_recordset(parameters.sources)
    AS item(route integer, original uuid, terminal uuid, source_revision text, present boolean)
  WHERE present AND route BETWEEN parameters.home * 16 AND parameters.home * 16 + 15
)
SELECT requested.original::text AS original
FROM requested
JOIN core.partition p ON p.partition_no=(SELECT home FROM parameters) AND p.write_state='active'
JOIN semantic.subject s ON (s.route,s.subject_id)=(requested.route,requested.original)
JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(s.route,s.subject_id) AND m.owner_epoch=p.epoch
JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(s.route,s.subject_id)
JOIN semantic.identity_epoch_mapping_fence f ON (f.route,f.destination)=(s.route,s.subject_id)
JOIN semantic.identity_epoch_mapping_effect e
  ON e.partition_no=p.partition_no AND e.transaction_id=f.transaction_id
    AND e.job_id=f.job_id AND e.job_epoch=f.job_epoch AND e.xmin=f.xmin
JOIN semantic.identity_epoch_home_gate g
  ON g.route=f.route AND g.destination=f.destination AND g.recorded_transaction_id=e.transaction_id
    AND g.pending_job=e.job_id AND g.pending_epoch=e.job_epoch AND g.xmin=e.xmin
JOIN semantic.identity_epoch_native_commit n
  ON n.partition_no=e.partition_no AND n.transaction_id=e.transaction_id AND n.xmin=e.xmin
    AND n.purpose='mapping' AND n.epoch=p.epoch AND n.position<=p.position
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect WHERE route=s.route AND subject_id=s.subject_id
  ORDER BY sequence DESC LIMIT 1
) redirect ON true
WHERE d.revision::text=requested.source_revision
  AND coalesce(redirect.target,s.subject_id)=requested.terminal
  AND m.closure_state IN ('legacy','active')
  AND m.closure_source_reservation IS NULL AND m.closure_ticket_reservation IS NULL
  AND m.closure_successor_ticket IS NULL AND m.closure_successor_original IS NULL
  AND m.closure_cancelled_successor IS NULL AND m.closure_claim IS NULL AND m.closure_mutation_xid IS NULL
  AND e.source_image_version=1 AND e.source_image_digest IS NOT NULL
  AND e.source_image_digest=semantic.identity_epoch_source_image_v1(p.partition_no,s.subject_id,e.transaction_id);
