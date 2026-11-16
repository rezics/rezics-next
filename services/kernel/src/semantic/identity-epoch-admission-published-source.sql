-- A fresh installation has no legacy source-home seals. Prove the current
-- point from its mapping command and the same job's published output.
SELECT m.original
FROM semantic.identity_epoch_mapping m
JOIN core.partition source_owner ON source_owner.partition_no=m.route/16
  AND source_owner.epoch=m.owner_epoch AND source_owner.write_state='active'
JOIN semantic.identity_epoch_mapping_effect e
  ON (e.partition_no,e.transaction_id)=(source_owner.partition_no,m.recorded_transaction_id)
  AND e.xmin=m.xmin AND e.job_epoch=m.epoch
JOIN semantic.identity_epoch_native_commit n
  ON (n.partition_no,n.transaction_id)=(e.partition_no,e.transaction_id)
  AND n.xmin=e.xmin AND n.purpose='mapping'
  AND n.epoch=source_owner.epoch AND n.position<=source_owner.position
JOIN semantic.identity_epoch_job j
  ON j.partition_no=(get_byte(uuid_send(e.job_id),10)*256+get_byte(uuid_send(e.job_id),11))/16
  AND j.job_id=e.job_id AND j.epoch=e.job_epoch AND j.scope_digest=e.scope_digest AND j.state='published'
JOIN semantic.identity_epoch_mapping_head h
  ON (h.partition_no,h.job_id)=(j.partition_no,j.job_id)
JOIN semantic.identity_epoch_group g
  ON (g.partition_no,g.terminal)=(m.control_partition,m.control_group)
JOIN core.partition group_owner ON group_owner.partition_no=g.partition_no
  AND group_owner.epoch=g.owner_epoch AND group_owner.write_state='active'
JOIN semantic.identity_epoch_original member
  ON (member.partition_no,member.generation,member.original)=(g.partition_no,g.generation,m.original)
  AND member.terminal=g.terminal AND member.present
LEFT JOIN semantic.identity_epoch_dirty d ON (d.route,d.original)=(m.route,m.original)
WHERE (m.route,m.original,m.recorded_transaction_id)=($1,$2,$3)
  AND (g.partition_no,g.terminal,g.generation)=($4,$5,$6)
  AND m.origin='published' AND m.closure_state='legacy' AND m.terminal=g.terminal
  -- The job can settle later membership writes on the same terminal after updating its mapping.
  AND m.source_revision<=coalesce(d.revision,0) AND coalesce(d.revision,0)=coalesce(d.captured_revision,0)
  AND g.ready AND g.closure_state='open' AND g.pending_job IS NULL
  AND h.frontier->'after'->>1='complete'
  AND h.outputs @> jsonb_build_array(jsonb_build_object('home',g.partition_no,'terminal',g.terminal,'generation',g.generation))
  AND EXISTS (SELECT 1 FROM semantic.read_identity_epoch_installation() i WHERE i.valid AND i.mode='absence');
