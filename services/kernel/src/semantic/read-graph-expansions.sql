WITH RECURSIVE
input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no,
         :limit::integer AS page_size,
         :edge_budget::integer AS edge_budget
),
requests AS MATERIALIZED (
  SELECT ordinal, node::uuid AS node_id, route, property, direction
  FROM jsonb_to_recordset(:requests::jsonb)
    AS requested(ordinal integer, node text, route integer, property text, direction text)
),
counted AS MATERIALIZED (
  SELECT request.*,
         COALESCE(outbound.value, inbound.value, 0)::bigint AS relation_count
  FROM requests AS request
  CROSS JOIN input
  LEFT JOIN LATERAL (
    SELECT value FROM semantic.outbound_link_count
    WHERE request.direction = 'out'
      AND context_id = '00000000-0000-8000-8000-000000000000'::uuid
      AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
      AND route = request.route AND subject_id = request.node_id
      AND property = request.property
      AND filter_value = '00000000-0000-0000-0000-000000000000'::uuid
    LIMIT 1 OFFSET 0
  ) AS outbound ON true
  LEFT JOIN LATERAL (
    SELECT value FROM semantic.inbound_link_count
    WHERE request.direction = 'in'
      AND context_id = '00000000-0000-8000-8000-000000000000'::uuid
      AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
      AND route = request.route AND subject_id = request.node_id
      AND property = request.property
      AND filter_value = '00000000-0000-0000-0000-000000000000'::uuid
    LIMIT 1 OFFSET 0
  ) AS inbound ON true
),
walk AS (
  SELECT request.ordinal,
         0::integer AS emitted_before,
         LEAST(input.page_size, input.edge_budget, page.fetched_count)::integer AS emitted_after,
         page.rows,
         page.fetched_count
  FROM counted AS request
  CROSS JOIN input
  CROSS JOIN LATERAL (
    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'other', edge.other_id::text,
                 'statement', edge.statement_id::text,
                 'orderKey', edge.order_key
               ) ORDER BY edge.order_key COLLATE "C", edge.sort_subject_id, edge.statement_id
             ),
             '[]'::jsonb
           ) AS rows,
           COUNT(*)::integer AS fetched_count
    FROM (
      (
        SELECT NULLIF(link.target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid) AS other_id,
               link.target_subject_id AS sort_subject_id,
               link.statement_id,
               link.order_key
        FROM semantic.outbound_link AS link
        WHERE request.direction = 'out'
          AND link.context_id = '00000000-0000-8000-8000-000000000000'::uuid
          AND link.route >= input.partition_no * 16 AND link.route < (input.partition_no + 1) * 16
          AND link.route = request.route AND link.subject_id = request.node_id
          AND link.present AND link.relation AND link.property = request.property
          AND link.filter_value = '00000000-0000-0000-0000-000000000000'::uuid
        ORDER BY link.order_key, link.target_subject_id, link.statement_id
        LIMIT LEAST(input.page_size + 1, input.edge_budget + 1)
      )
      UNION ALL
      (
        SELECT link.source_subject_id AS other_id,
               link.source_subject_id AS sort_subject_id,
               link.statement_id,
               link.order_key
        FROM semantic.inbound_link AS link
        WHERE request.direction = 'in'
          AND link.context_id = '00000000-0000-8000-8000-000000000000'::uuid
          AND link.route >= input.partition_no * 16 AND link.route < (input.partition_no + 1) * 16
          AND link.route = request.route AND link.subject_id = request.node_id
          AND link.present AND link.property = request.property
          AND link.filter_value = '00000000-0000-0000-0000-000000000000'::uuid
        ORDER BY link.order_key, link.source_subject_id, link.statement_id
        LIMIT LEAST(input.page_size + 1, input.edge_budget + 1)
      )
    ) AS edge
  ) AS page
  WHERE request.ordinal = 1 AND input.edge_budget > 0

  UNION ALL

  SELECT request.ordinal,
         walk.emitted_after AS emitted_before,
         (walk.emitted_after + LEAST(input.page_size,
                                     input.edge_budget - walk.emitted_after,
                                     page.fetched_count))::integer AS emitted_after,
         page.rows,
         page.fetched_count
  FROM walk
  JOIN counted AS request ON request.ordinal = walk.ordinal + 1
  CROSS JOIN input
  CROSS JOIN LATERAL (
    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'other', edge.other_id::text,
                 'statement', edge.statement_id::text,
                 'orderKey', edge.order_key
               ) ORDER BY edge.order_key COLLATE "C", edge.sort_subject_id, edge.statement_id
             ),
             '[]'::jsonb
           ) AS rows,
           COUNT(*)::integer AS fetched_count
    FROM (
      (
        SELECT NULLIF(link.target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid) AS other_id,
               link.target_subject_id AS sort_subject_id,
               link.statement_id,
               link.order_key
        FROM semantic.outbound_link AS link
        WHERE request.direction = 'out'
          AND link.context_id = '00000000-0000-8000-8000-000000000000'::uuid
          AND link.route >= input.partition_no * 16 AND link.route < (input.partition_no + 1) * 16
          AND link.route = request.route AND link.subject_id = request.node_id
          AND link.present AND link.relation AND link.property = request.property
          AND link.filter_value = '00000000-0000-0000-0000-000000000000'::uuid
        ORDER BY link.order_key, link.target_subject_id, link.statement_id
        LIMIT LEAST(input.page_size + 1, input.edge_budget - walk.emitted_after + 1)
      )
      UNION ALL
      (
        SELECT link.source_subject_id AS other_id,
               link.source_subject_id AS sort_subject_id,
               link.statement_id,
               link.order_key
        FROM semantic.inbound_link AS link
        WHERE request.direction = 'in'
          AND link.context_id = '00000000-0000-8000-8000-000000000000'::uuid
          AND link.route >= input.partition_no * 16 AND link.route < (input.partition_no + 1) * 16
          AND link.route = request.route AND link.subject_id = request.node_id
          AND link.present AND link.property = request.property
          AND link.filter_value = '00000000-0000-0000-0000-000000000000'::uuid
        ORDER BY link.order_key, link.source_subject_id, link.statement_id
        LIMIT LEAST(input.page_size + 1, input.edge_budget - walk.emitted_after + 1)
      )
    ) AS edge
  ) AS page
  WHERE walk.emitted_after < input.edge_budget
)
SELECT request.ordinal,
       request.node_id::text AS node,
       request.property,
       request.direction,
       request.relation_count::text AS count,
       walk.rows AS page_rows,
       COALESCE(walk.fetched_count, 0)::integer AS fetched_count,
       CASE WHEN walk.ordinal IS NULL THEN NULL
            ELSE (input.edge_budget - walk.emitted_before)::integer
       END AS available_before,
       COALESCE(walk.emitted_before, 0)::integer AS emitted_before,
       COALESCE(walk.emitted_after, 0)::integer AS emitted_after,
       COALESCE(MAX(walk.emitted_after) OVER (), 0)::integer AS used,
       partition.epoch
FROM counted AS request
CROSS JOIN input
JOIN core.partition AS partition ON partition.partition_no = input.partition_no
LEFT JOIN walk ON walk.ordinal = request.ordinal
ORDER BY request.ordinal;
