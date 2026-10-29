-- Merge the ordered layers, prefer Context at an equal key, then skip suppressions.
-- Page index keys before fetching payloads, so both ordered ranges can use index-only scans.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS r_route, :subject_id::uuid AS r_subject_id, :context_id::uuid AS r_context_id, :property::text AS r_property, :filter_value::uuid AS r_filter_value, :after_order::text AS r_after_order, :after_target::uuid AS r_after_target, :after_statement::uuid AS r_after_statement, :page_limit::integer AS r_page_limit
), page AS MATERIALIZED (
SELECT property, sort_subject, sort_statement, context_id, order_key FROM (
  -- Global has one unsuppressed ordered layer. Seek and limit it directly so page work is independent of degree.
  (SELECT link.property, link.target_subject_id AS sort_subject, link.statement_id AS sort_statement,
          link.context_id, link.order_key
   FROM semantic.outbound_link link CROSS JOIN input
   WHERE input.r_context_id = '00000000-0000-8000-8000-000000000000'::uuid
     AND link.route = input.r_route AND link.subject_id = input.r_subject_id AND link.present
     AND link.context_id = '00000000-0000-8000-8000-000000000000'::uuid
     AND link.property = input.r_property AND link.filter_value = input.r_filter_value AND link.relation
     AND (link.order_key, link.target_subject_id, link.statement_id) >
         (input.r_after_order COLLATE "C", input.r_after_target, input.r_after_statement)
   ORDER BY link.order_key, link.target_subject_id, link.statement_id
   LIMIT (SELECT r_page_limit FROM input))
  UNION ALL
  (
SELECT property, sort_subject, sort_statement, context_id, order_key FROM (
  SELECT DISTINCT ON (order_key, sort_subject, sort_statement) * FROM (
(SELECT property, context_id, order_key, target_subject_id AS sort_subject, statement_id AS sort_statement,
        false AS suppressed, 0 AS layer
  FROM semantic.outbound_link CROSS JOIN input
  WHERE route = input.r_route AND subject_id = input.r_subject_id AND present
    AND context_id = '00000000-0000-8000-8000-000000000000'::uuid
    AND property = input.r_property AND filter_value = input.r_filter_value AND relation
    AND (order_key, target_subject_id, statement_id) > (input.r_after_order COLLATE "C", input.r_after_target, input.r_after_statement)
  ORDER BY order_key, target_subject_id, statement_id, layer DESC)
UNION ALL
(SELECT property, context_id, order_key, target_subject_id AS sort_subject, statement_id AS sort_statement,
        suppressed, 1 AS layer
  FROM semantic.outbound_link CROSS JOIN input
  WHERE route = input.r_route AND subject_id = input.r_subject_id AND present
    AND context_id = input.r_context_id AND input.r_context_id <> '00000000-0000-8000-8000-000000000000'
    AND property = input.r_property AND filter_value = input.r_filter_value AND relation
    AND (order_key, target_subject_id, statement_id) > (input.r_after_order COLLATE "C", input.r_after_target, input.r_after_statement)
  ORDER BY order_key, target_subject_id, statement_id, layer DESC)
  ) layers
  ORDER BY order_key, sort_subject, sort_statement, layer DESC
) selected
WHERE NOT suppressed
  AND (SELECT r_context_id FROM input) <> '00000000-0000-8000-8000-000000000000'::uuid
ORDER BY order_key, sort_subject, sort_statement
LIMIT (SELECT r_page_limit FROM input)
  )
)
SELECT link.property, link.statement_id::text AS statement, link.slot_id::text AS slot,
       NULLIF(link.target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target,
       link.target_type AS type, link.external, link.value, link.order_key
FROM page CROSS JOIN input
JOIN LATERAL (
 SELECT * FROM semantic.outbound_link link
 WHERE link.route = input.r_route AND link.subject_id = input.r_subject_id AND link.context_id = page.context_id
 AND link.property = page.property AND link.filter_value = input.r_filter_value AND link.order_key = page.order_key
 AND link.target_subject_id = page.sort_subject AND link.statement_id = page.sort_statement
 LIMIT 1
) link ON true
ORDER BY page.order_key, page.sort_subject, page.sort_statement;
