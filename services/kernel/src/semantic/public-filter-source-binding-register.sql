WITH active_owner AS MATERIALIZED (
  SELECT p.partition_no,p.epoch,:route_digest::text AS route_digest FROM core.partition p
  WHERE p.partition_no=0 AND p.write_state='active' AND p.epoch>0
), retained AS MATERIALIZED (
  SELECT s.source_id,s.configuration,s.owner_epoch
  FROM active_owner p
  JOIN semantic.public_filter_source s ON (s.partition_no,s.owner_epoch)=(p.partition_no,p.epoch)
  WHERE s.route_digest=p.route_digest AND s.family='global-subject-v1'
  FOR SHARE OF s
), registered AS (
  INSERT INTO semantic.public_filter_source(partition_no,route_digest,owner_epoch,family)
  SELECT p.partition_no,p.route_digest,p.epoch,'global-subject-v1' FROM active_owner p
  WHERE NOT EXISTS (SELECT 1 FROM retained)
  ON CONFLICT(partition_no,route_digest,owner_epoch,family)
  DO UPDATE SET route_digest=EXCLUDED.route_digest
  RETURNING source_id,configuration,owner_epoch
)
SELECT source_id::text,configuration::text,owner_epoch FROM retained
UNION ALL
SELECT source_id::text,configuration::text,owner_epoch FROM registered;
