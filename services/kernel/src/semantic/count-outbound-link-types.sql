-- Merge the ordered layers, prefer Context at an equal key, then skip suppressions.
-- The outer limit stops the index ranges without materializing their full contents.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS r_route, :subject_id::uuid AS r_subject_id, :context_id::uuid AS r_context_id, :property::text AS r_property, :filter_value::uuid AS r_filter_value, ''::text AS r_after_order, '00000000-0000-0000-0000-000000000000'::uuid AS r_after_target, '00000000-0000-0000-0000-000000000000'::uuid AS r_after_statement
)
SELECT type FROM (
  SELECT DISTINCT ON (order_key, sort_subject, sort_statement) * FROM (
(SELECT property, statement_id::text AS statement, slot_id::text AS slot, NULLIF(target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target, target_type AS type, external, value, order_key, target_subject_id AS sort_subject, statement_id AS sort_statement,
        false AS suppressed, 0 AS layer
  FROM semantic.outbound_link CROSS JOIN input
  WHERE route = input.r_route AND subject_id = input.r_subject_id AND present
    AND context_id = '00000000-0000-8000-8000-000000000000'::uuid
    AND property = input.r_property AND filter_value = input.r_filter_value AND relation
    AND (order_key, target_subject_id, statement_id) > (input.r_after_order COLLATE "C", input.r_after_target, input.r_after_statement)
  ORDER BY order_key, target_subject_id, statement_id, layer DESC)
UNION ALL
(SELECT property, statement_id::text AS statement, slot_id::text AS slot, NULLIF(target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target, target_type AS type, external, value, order_key, target_subject_id AS sort_subject, statement_id AS sort_statement,
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
ORDER BY order_key, sort_subject, sort_statement
LIMIT 1000;
