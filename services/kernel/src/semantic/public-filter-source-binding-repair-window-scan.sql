WITH RECURSIVE input AS (
  SELECT :bootstrap::uuid AS bootstrap,
         :consumer::text AS consumer,
         :partition_no::integer AS first_partition,
         :through::integer AS through_partition
), home_scan(partition_no,epoch,write_state,owner_epoch,complete,creation_consumer,base,receipt,head,checkpoint,checkpoint_epoch) AS (
  SELECT i.first_partition,p.epoch,p.write_state,e.owner_epoch,e.complete,e.creation_consumer,
         e.creation_position::text,e.receipt,p.position::text,c.position::text,c.epoch
  FROM input i
  LEFT JOIN semantic.public_filter_home_enrollment e
    ON (e.partition_no,e.bootstrap)=(i.first_partition,i.bootstrap)
      AND e.creation_consumer=i.consumer
  LEFT JOIN core.partition p ON p.partition_no=i.first_partition
  LEFT JOIN core.consumer_checkpoint c
    ON (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)
  UNION ALL
  SELECT previous.partition_no+1,p.epoch,p.write_state,e.owner_epoch,e.complete,e.creation_consumer,
         e.creation_position::text,e.receipt,p.position::text,c.position::text,c.epoch
  FROM home_scan previous
  CROSS JOIN input i
  LEFT JOIN semantic.public_filter_home_enrollment e
    ON (e.partition_no,e.bootstrap)=(previous.partition_no+1,i.bootstrap)
      AND e.creation_consumer=i.consumer
  LEFT JOIN core.partition p ON p.partition_no=previous.partition_no+1
  LEFT JOIN core.consumer_checkpoint c
    ON (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)
  WHERE previous.head IS NOT NULL AND previous.base IS NOT NULL
    AND previous.head=previous.base AND previous.partition_no<i.through_partition
)
SELECT partition_no,epoch,write_state,owner_epoch,complete,creation_consumer,
       base,receipt,head,checkpoint,checkpoint_epoch
FROM home_scan
ORDER BY partition_no;
