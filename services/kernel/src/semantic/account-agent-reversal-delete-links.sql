WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :receipt_id::text AS receipt_id,
         :account_id::uuid AS account_id, :survivor::uuid AS survivor,
         :moved_from::uuid AS moved_from, :context_id::uuid AS context_id,
         :links::jsonb AS links
), moved_rows AS MATERIALIZED (
  SELECT link.ctid, link.subject_id, link.context_id, link.property, link.filter_value,
         link.source_subject_id, link.statement_id, link.present, link.suppressed
  FROM input
  CROSS JOIN LATERAL jsonb_to_recordset(input.links) AS moved(
    context_id uuid, property text, source_subject_id uuid, statement_id uuid, filter_value uuid
  )
  JOIN LATERAL (
    SELECT link.ctid, link.subject_id, link.context_id, link.property, link.filter_value,
           link.source_subject_id, link.statement_id, link.present, link.suppressed
    FROM semantic.inbound_link AS link
    WHERE link.route = input.route AND link.subject_id = input.survivor
      AND link.context_id = input.context_id AND link.context_id = moved.context_id
      AND link.property = moved.property AND link.source_subject_id = moved.source_subject_id
      AND link.statement_id = moved.statement_id AND link.filter_value = moved.filter_value
    LIMIT 1
  ) AS link ON true
), deleted AS (
  DELETE FROM semantic.inbound_link AS link
  USING input
  WHERE link.route = input.route AND link.context_id = input.context_id
    AND link.ctid = ANY(ARRAY(SELECT moved_rows.ctid FROM moved_rows))
  RETURNING link.subject_id, link.context_id, link.property, link.filter_value,
            link.source_subject_id, link.statement_id, link.present, link.suppressed
), reversed AS (
  UPDATE semantic.account_agent_moved_link AS moved
  SET reversed = true
  FROM input, jsonb_to_recordset(input.links) AS page(
    context_id uuid, property text, source_subject_id uuid, statement_id uuid, filter_value uuid
  )
  WHERE moved.route = input.route AND moved.receipt_id = input.receipt_id
    AND moved.account_id = input.account_id AND moved.survivor = input.survivor
    AND moved.moved_from = input.moved_from AND moved.context_id = page.context_id
    AND moved.property = page.property AND moved.source_subject_id = page.source_subject_id
    AND moved.statement_id = page.statement_id AND moved.filter_value = page.filter_value
  RETURNING moved.statement_id
), global_deltas AS (
  SELECT deleted.subject_id, deleted.property, deleted.filter_value, -count(*)::bigint AS delta
  FROM deleted CROSS JOIN input
  WHERE deleted.context_id = '00000000-0000-8000-8000-000000000000'::uuid AND deleted.present
  GROUP BY deleted.subject_id, deleted.property, deleted.filter_value
), global_counts AS (
  INSERT INTO semantic.inbound_link_count(route, subject_id, property, filter_value, value)
  SELECT input.route, delta.subject_id, delta.property, delta.filter_value,
         COALESCE(current.value, 0) + delta.delta
  FROM global_deltas AS delta CROSS JOIN input
  LEFT JOIN LATERAL (
    SELECT current.value FROM semantic.inbound_link_count AS current
    WHERE current.route = input.route AND current.subject_id = delta.subject_id
      AND current.property = delta.property AND current.filter_value = delta.filter_value
    LIMIT 1
  ) AS current ON true
  ON CONFLICT (route, subject_id, property, filter_value)
  DO UPDATE SET value = EXCLUDED.value
  RETURNING subject_id
), context_deltas AS (
  SELECT deleted.subject_id, deleted.context_id, deleted.property, deleted.filter_value,
         -sum(CASE WHEN deleted.present
             THEN (NOT deleted.suppressed)::integer - COALESCE(base.present, false)::integer
             ELSE 0 END)::bigint AS delta
  FROM deleted CROSS JOIN input
  LEFT JOIN LATERAL (
    SELECT base.present FROM semantic.inbound_link AS base
    WHERE deleted.context_id <> '00000000-0000-8000-8000-000000000000'::uuid
      AND base.route = input.route AND base.subject_id = deleted.subject_id
      AND base.context_id = '00000000-0000-8000-8000-000000000000'::uuid
      AND base.property = deleted.property AND base.filter_value = deleted.filter_value
      AND base.statement_id = deleted.statement_id AND base.source_subject_id = deleted.source_subject_id
    LIMIT 1
  ) AS base ON true
  WHERE deleted.context_id <> '00000000-0000-8000-8000-000000000000'::uuid
  GROUP BY deleted.subject_id, deleted.context_id, deleted.property, deleted.filter_value
  UNION ALL
  SELECT deleted.subject_id, local.context_id, deleted.property, deleted.filter_value, count(*)::bigint AS delta
  FROM deleted CROSS JOIN input
  JOIN LATERAL (
    SELECT local.context_id FROM semantic.inbound_link AS local
    WHERE deleted.context_id = '00000000-0000-8000-8000-000000000000'::uuid AND deleted.present
      AND local.route = input.route AND local.subject_id = deleted.subject_id
      AND local.context_id <> '00000000-0000-8000-8000-000000000000'::uuid
      AND local.property = deleted.property AND local.filter_value = deleted.filter_value
      AND local.statement_id = deleted.statement_id AND local.source_subject_id = deleted.source_subject_id
      AND local.present
  ) AS local ON true
  WHERE deleted.context_id = '00000000-0000-8000-8000-000000000000'::uuid
  GROUP BY deleted.subject_id, local.context_id, deleted.property, deleted.filter_value
), context_totals AS (
  SELECT subject_id, context_id, property, filter_value, sum(delta) AS delta
  FROM context_deltas
  GROUP BY subject_id, context_id, property, filter_value
)
INSERT INTO semantic.inbound_link_context_count(route, subject_id, context_id, property, filter_value, value)
SELECT input.route, delta.subject_id, delta.context_id, delta.property, delta.filter_value,
       COALESCE(current.value, 0) + delta.delta
FROM context_totals AS delta CROSS JOIN input
LEFT JOIN semantic.inbound_link_context_count AS current
  ON current.route = input.route AND current.subject_id = delta.subject_id
 AND current.context_id = delta.context_id AND current.property = delta.property
 AND current.filter_value = delta.filter_value
WHERE delta.delta <> 0
ON CONFLICT (route, subject_id, context_id, property, filter_value)
DO UPDATE SET value = EXCLUDED.value;
