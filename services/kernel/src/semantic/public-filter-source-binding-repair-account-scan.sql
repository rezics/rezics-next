WITH RECURSIVE input AS (
  SELECT :partition_no::integer AS first_partition,
         :through::integer AS through_partition,
         :after_route::integer AS after_route,
         :after_id::uuid AS after_id,
         :claim_inputs::boolean AS claim_inputs
), home_scan(partition_no,epoch,write_state,route,account_id,candidate_count,candidate_keys) AS (
  SELECT i.first_partition,p.epoch,p.write_state,key.route,key.account_id,key.candidate_count,key.candidate_keys
  FROM input i
  LEFT JOIN core.partition p ON p.partition_no=i.first_partition
  LEFT JOIN LATERAL (
    SELECT
      (array_agg(candidate.route ORDER BY candidate.route,candidate.account_id))[1] AS route,
      (array_agg(candidate.account_id ORDER BY candidate.route,candidate.account_id))[1] AS account_id,
      count(*)::integer AS candidate_count,
      COALESCE(
        jsonb_agg(jsonb_build_array(candidate.route,candidate.account_id::text)
          ORDER BY candidate.route,candidate.account_id),
        '[]'::jsonb
      ) AS candidate_keys
    FROM (
      (SELECT a.route,a.account_id FROM access.account a
       WHERE a.route >= i.first_partition*16 AND a.route < (i.first_partition+1)*16
         AND (a.route,a.account_id) > (i.after_route,i.after_id)
       ORDER BY a.route,a.account_id LIMIT 1)
      UNION ALL
      (SELECT a.route,a.account_id FROM access.account_discovery_intent a
       WHERE a.route >= i.first_partition*16 AND a.route < (i.first_partition+1)*16
         AND (a.route,a.account_id) > (i.after_route,i.after_id)
       ORDER BY a.route,a.account_id LIMIT 1)
      UNION ALL
      (SELECT a.route,a.account_id FROM access.account_discovery_claim_intent a
       WHERE i.claim_inputs
         AND a.route >= i.first_partition*16 AND a.route < (i.first_partition+1)*16
         AND (a.route,a.account_id) > (i.after_route,i.after_id)
       ORDER BY a.route,a.account_id LIMIT 1)
    ) candidate
  ) key ON TRUE
  UNION ALL
  SELECT previous.partition_no+1,p.epoch,p.write_state,key.route,key.account_id,key.candidate_count,key.candidate_keys
  FROM home_scan previous
  CROSS JOIN input i
  LEFT JOIN core.partition p ON p.partition_no=previous.partition_no+1
  LEFT JOIN LATERAL (
    SELECT
      (array_agg(candidate.route ORDER BY candidate.route,candidate.account_id))[1] AS route,
      (array_agg(candidate.account_id ORDER BY candidate.route,candidate.account_id))[1] AS account_id,
      count(*)::integer AS candidate_count,
      COALESCE(
        jsonb_agg(jsonb_build_array(candidate.route,candidate.account_id::text)
          ORDER BY candidate.route,candidate.account_id),
        '[]'::jsonb
      ) AS candidate_keys
    FROM (
      (SELECT a.route,a.account_id FROM access.account a
       WHERE a.route >= (previous.partition_no+1)*16 AND a.route < (previous.partition_no+2)*16
         AND (a.route,a.account_id) > ((previous.partition_no+1)*16,'00000000-0000-0000-0000-000000000000'::uuid)
       ORDER BY a.route,a.account_id LIMIT 1)
      UNION ALL
      (SELECT a.route,a.account_id FROM access.account_discovery_intent a
       WHERE a.route >= (previous.partition_no+1)*16 AND a.route < (previous.partition_no+2)*16
         AND (a.route,a.account_id) > ((previous.partition_no+1)*16,'00000000-0000-0000-0000-000000000000'::uuid)
       ORDER BY a.route,a.account_id LIMIT 1)
      UNION ALL
      (SELECT a.route,a.account_id FROM access.account_discovery_claim_intent a
       WHERE i.claim_inputs
         AND a.route >= (previous.partition_no+1)*16 AND a.route < (previous.partition_no+2)*16
         AND (a.route,a.account_id) > ((previous.partition_no+1)*16,'00000000-0000-0000-0000-000000000000'::uuid)
       ORDER BY a.route,a.account_id LIMIT 1)
    ) candidate
  ) key ON TRUE
  WHERE previous.candidate_count=0 AND previous.partition_no<i.through_partition
)
SELECT partition_no,epoch,write_state,route,account_id::text AS account_id,candidate_count,candidate_keys
FROM home_scan
ORDER BY partition_no;
