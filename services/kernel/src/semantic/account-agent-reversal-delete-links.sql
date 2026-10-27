WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :receipt_id::text AS receipt_id,
         :account_id::uuid AS account_id, :survivor::uuid AS survivor,
         :moved_from::uuid AS moved_from, :links::jsonb AS links
), moved_rows AS MATERIALIZED (
  SELECT link.ctid, link.subject_id, link.property, link.filter_value, link.present
  FROM input
  CROSS JOIN LATERAL jsonb_to_recordset(input.links) AS moved(
    property text, source_subject_id uuid, statement_id uuid, filter_value uuid
  )
  JOIN LATERAL (
    SELECT link.ctid, link.subject_id, link.property, link.filter_value, link.present
    FROM semantic.inbound_link AS link
    WHERE link.route = input.route AND link.subject_id = input.survivor
      AND link.property = moved.property AND link.source_subject_id = moved.source_subject_id
      AND link.statement_id = moved.statement_id AND link.filter_value = moved.filter_value
    LIMIT 1
  ) AS link ON true
), deleted AS (
  DELETE FROM semantic.inbound_link AS link
  USING input
  WHERE link.route = input.route
    AND link.ctid = ANY(ARRAY(SELECT moved_rows.ctid FROM moved_rows))
  RETURNING link.subject_id, link.property, link.filter_value, link.present
), reversed AS (
  UPDATE semantic.account_agent_moved_link AS moved
  SET reversed = true
  FROM input, jsonb_to_recordset(input.links) AS page(
    property text, source_subject_id uuid, statement_id uuid, filter_value uuid
  )
  WHERE moved.route = input.route AND moved.receipt_id = input.receipt_id
    AND moved.account_id = input.account_id AND moved.survivor = input.survivor
    AND moved.moved_from = input.moved_from AND moved.property = page.property
    AND moved.source_subject_id = page.source_subject_id AND moved.statement_id = page.statement_id
    AND moved.filter_value = page.filter_value
  RETURNING moved.statement_id
), deltas AS (
  SELECT subject_id, property, filter_value, -count(*)::bigint AS delta
  FROM deleted WHERE present
  GROUP BY subject_id, property, filter_value
)
INSERT INTO semantic.inbound_link_count(route, subject_id, property, filter_value, value)
SELECT input.route, delta.subject_id, delta.property, delta.filter_value,
       COALESCE(current.value, 0) + delta.delta
FROM deltas AS delta CROSS JOIN input
LEFT JOIN LATERAL (
  SELECT current.value FROM semantic.inbound_link_count AS current
  WHERE current.route = input.route AND current.subject_id = delta.subject_id
    AND current.property = delta.property AND current.filter_value = delta.filter_value
  LIMIT 1
) AS current ON true
ON CONFLICT (route, subject_id, property, filter_value)
DO UPDATE SET value = EXCLUDED.value;
