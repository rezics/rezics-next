WITH parameters AS (SELECT $1::integer AS partition_no, $2::jsonb AS sources),
requested AS MATERIALIZED (
  SELECT route, original, source_revision
  FROM parameters, jsonb_to_recordset(parameters.sources)
    AS item(route integer, original uuid, source_revision text, present boolean)
  WHERE present AND route BETWEEN parameters.partition_no * 16 AND parameters.partition_no * 16 + 15
)
SELECT requested.original::text AS original
FROM requested
JOIN semantic.subject s ON (s.route,s.subject_id)=(requested.route,requested.original)
JOIN semantic.revision r ON (r.route,r.subject_id,r.revision)=(s.route,s.subject_id,1) AND r.kind='create'
JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(s.route,s.subject_id)
JOIN semantic.identity_epoch_home_gate g ON (g.route,g.destination,g.original)=(s.route,s.subject_id,s.subject_id)
JOIN core.partition p ON p.partition_no=(SELECT partition_no FROM parameters)
LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(s.route,s.subject_id)
WHERE r.recorded_transaction_id=s.recorded_transaction_id
  AND r.recorded_transaction_id=m.recorded_transaction_id AND r.recorded_transaction_id=g.recorded_transaction_id
  AND r.xmin=s.xmin AND r.xmin=m.xmin AND r.xmin=g.xmin
  AND m.origin='creation' AND m.terminal=s.subject_id AND m.control_group=s.subject_id
  AND m.control_partition=p.partition_no AND m.owner_epoch=p.epoch AND p.write_state='active'
  AND m.epoch>0 AND g.epoch=m.epoch AND g.terminal=s.subject_id
  AND coalesce(d.revision,0)::text=requested.source_revision
  AND coalesce(d.captured_revision,0)::text=requested.source_revision
  AND NOT EXISTS(SELECT 1 FROM semantic.revision later
    WHERE later.route=s.route AND later.subject_id=s.subject_id AND later.revision>1)
  AND NOT EXISTS(SELECT 1 FROM semantic.redirect redirect
    WHERE redirect.route=s.route AND redirect.subject_id=s.subject_id);
