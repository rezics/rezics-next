/* semantic.native-keyed:9:17 */
WITH input AS (SELECT :partition_no::integer AS partition_no,:route::integer AS route,:subject_id::uuid AS subject_id),
head AS MATERIALIZED (
  SELECT h.partition_no,h.position,h.owner_epoch FROM semantic.public_filter_privacy_head h
  JOIN core.partition p ON p.partition_no=h.partition_no AND p.epoch=h.owner_epoch
  WHERE h.partition_no=(SELECT partition_no FROM input) AND NOT h.population_fenced AND p.write_state='active'
  FOR UPDATE OF h
), own_baseline AS (
  INSERT INTO semantic.public_filter_privacy_subject(partition_no,route,subject_id,owner_epoch,position)
  SELECT h.partition_no,s.route,s.subject_id,h.owner_epoch,h.position
  FROM head h JOIN semantic.subject s ON s.route=(SELECT route FROM input) AND s.subject_id=(SELECT subject_id FROM input)
    AND s.route/16=h.partition_no
  ON CONFLICT (partition_no,subject_id) DO NOTHING
  RETURNING subject_id
)
INSERT INTO semantic.public_filter_repair_advance
  (partition_no,bootstrap,execution,step,route,subject_id,owner_epoch,position,transaction_id,native_xid)
SELECT p.partition_no,:bootstrap::uuid,:execution::text,:step::uuid,s.route,s.subject_id,p.epoch,p.position+1,:transaction_id::uuid,pg_current_xact_id()
FROM core.partition p JOIN semantic.subject s ON s.route / 16 = p.partition_no
WHERE p.partition_no = (SELECT partition_no FROM input) AND p.write_state = 'active'
  AND s.route = (SELECT route FROM input) AND s.subject_id = (SELECT subject_id FROM input)
  AND EXISTS(SELECT 1 FROM head)
ON CONFLICT DO NOTHING
RETURNING position::text, owner_epoch, transaction_id::text, native_xid::text;
