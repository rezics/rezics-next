WITH input AS (
  SELECT :mixed::boolean AS mixed,:request_key::text AS request_key,:read_definition::uuid AS definition,
    :consumer::text AS consumer,:snapshot_kind::text AS snapshot_kind
), original AS MATERIALIZED (
  SELECT b.bootstrap FROM input i JOIN semantic.public_filter_bootstrap b
    ON (b.partition_no,b.request_key,b.snapshot_kind)=(0,i.request_key,'prepared')
  JOIN core.subject_subscription_v1 m ON m.bootstrap=b.bootstrap
  WHERE b.subscription_protocol=1 AND (b.read_definition,b.consumer)=(i.definition,i.consumer)
    AND i.snapshot_kind='prepared' AND b.state IN ('capturing','begun')
), inserted AS (
  INSERT INTO semantic.public_filter_bootstrap
    (partition_no,bootstrap,read_definition,request_key,consumer,snapshot_kind,native_snapshot,
     owner_epoch,source_position,state,account_after)
  SELECT s.partition_no,:bootstrap::uuid,d.read_definition,i.request_key,i.consumer,i.snapshot_kind,
    pg_current_snapshot(),p.epoch,p.position,'capturing',0
  FROM input i JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(0,i.definition)
  JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=(d.partition_no,d.source_id,d.configuration)
  JOIN core.partition p ON p.partition_no=s.partition_no AND s.owner_epoch=p.epoch AND p.write_state='active'
  WHERE NOT EXISTS (SELECT FROM original)
  ON CONFLICT(partition_no,request_key) WHERE state='capturing'
  DO UPDATE SET request_key=EXCLUDED.request_key RETURNING bootstrap
)
SELECT bootstrap::text FROM original UNION ALL SELECT bootstrap::text FROM inserted;
