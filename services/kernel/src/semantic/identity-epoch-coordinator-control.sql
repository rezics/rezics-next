SELECT j.state, c.published_epoch, c.pending_job, c.pending_epoch, c.prepare_job, c.prepare_epoch,
       ack.mapping_complete, ack.search_complete, ack.library_complete
FROM semantic.identity_epoch_job j
JOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active'
JOIN semantic.identity_epoch_control c ON c.partition_no=j.partition_no
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE a.step='mapping') > 0 AS mapping_complete,
         count(*) FILTER (WHERE a.step='search-canonical-index') > 0 AS search_complete,
         count(*) FILTER (WHERE a.step='library-private-follow-counts') > 0 AS library_complete
  FROM semantic.identity_epoch_ack a
  WHERE (a.partition_no,a.job_id)=(j.partition_no,j.job_id) AND a.progress->>'state'='complete'
) ack
WHERE (j.partition_no,j.job_id,j.epoch)=($1,$2,$3);
