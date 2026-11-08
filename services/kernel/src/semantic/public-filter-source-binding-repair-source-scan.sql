WITH RECURSIVE input AS (
  SELECT :partition_no::integer AS first_partition,
         :through::integer AS through_partition,
         :after_route::integer AS after_route,
         :after_id::uuid AS after_id
), home_scan(partition_no,epoch,write_state,route,subject_id) AS (
  SELECT i.first_partition,p.epoch,p.write_state,key.route,key.subject_id
  FROM input i
  LEFT JOIN core.partition p ON p.partition_no=i.first_partition
  LEFT JOIN LATERAL (
    SELECT s.route,s.subject_id
    FROM semantic.subject s
    WHERE s.route >= i.first_partition*16 AND s.route < (i.first_partition+1)*16
      AND (s.route,s.subject_id) > (i.after_route,i.after_id)
    ORDER BY s.route,s.subject_id LIMIT 1
  ) key ON TRUE
  UNION ALL
  SELECT previous.partition_no+1,p.epoch,p.write_state,key.route,key.subject_id
  FROM home_scan previous
  CROSS JOIN input i
  LEFT JOIN core.partition p ON p.partition_no=previous.partition_no+1
  LEFT JOIN LATERAL (
    SELECT s.route,s.subject_id
    FROM semantic.subject s
    WHERE s.route >= (previous.partition_no+1)*16
      AND s.route < (previous.partition_no+2)*16
      AND (s.route,s.subject_id) > ((previous.partition_no+1)*16,'00000000-0000-0000-0000-000000000000'::uuid)
    ORDER BY s.route,s.subject_id LIMIT 1
  ) key ON TRUE
  WHERE previous.subject_id IS NULL AND previous.partition_no < i.through_partition
)
SELECT partition_no,epoch,write_state,route,subject_id::text AS subject_id
FROM home_scan
ORDER BY partition_no;
