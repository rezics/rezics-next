SELECT p.epoch,p.position::text,s.subject_id::text,s.visibility,s.security_revision::text,s.current_release,
  s.projection_pending,r.revision,m.terminal::text,m.epoch::text AS identity_epoch,m.origin,m.owner_epoch,
  g.pending_job::text,coalesce(d.revision,0)::text AS dirty_revision,coalesce(d.captured_revision,0)::text AS captured_revision
FROM semantic.subject s
JOIN core.partition p ON p.partition_no=$1 AND p.write_state='active'
JOIN semantic.identity_epoch_mapping m ON m.route=s.route AND m.original=s.subject_id
LEFT JOIN semantic.identity_epoch_home_gate g ON g.route=s.route AND g.destination=s.subject_id AND g.original=s.subject_id
LEFT JOIN semantic.identity_epoch_dirty d ON d.route=s.route AND d.original=s.subject_id
JOIN LATERAL(SELECT revision FROM semantic.revision WHERE route=s.route AND subject_id=s.subject_id ORDER BY revision DESC LIMIT 1) r ON true
WHERE s.route=$2 AND s.subject_id=$3
FOR SHARE OF s,p,m;
