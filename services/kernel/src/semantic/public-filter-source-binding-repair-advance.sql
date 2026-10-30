INSERT INTO semantic.public_filter_repair_advance
  (partition_no,bootstrap,execution,step,route,subject_id,owner_epoch,position)
SELECT p.partition_no,:bootstrap::uuid,:execution::text,:step::uuid,s.route,s.subject_id,p.epoch,p.position+1
FROM core.partition p JOIN semantic.subject s ON s.route / 16 = p.partition_no
WHERE p.partition_no = :partition_no::integer AND p.write_state = 'active'
  AND s.route = :route::integer AND s.subject_id = :subject_id::uuid
ON CONFLICT DO NOTHING
RETURNING position::text, owner_epoch;
