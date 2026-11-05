-- Merge one payload-bearing seek per layer, preferring Context at an equal cursor.
-- Advance past suppressed keys without spending the visible page's sentinel budget.
WITH RECURSIVE input AS (
  SELECT :route::integer AS r_route, :subject_id::uuid AS r_subject_id,
         :context_id::uuid AS r_context_id, :property::text AS r_property,
         :filter_value::uuid AS r_filter_value, :after_order::text AS r_after_order,
         :after_target::uuid AS r_after_target, :after_statement::uuid AS r_after_statement,
         :page_limit::integer AS r_page_limit
), page AS (
  SELECT following.*, input.r_context_id AS selected_context, input.r_page_limit AS page_size,
         (NOT following.suppressed)::integer AS emitted
  FROM input CROSS JOIN LATERAL (
    SELECT * FROM (
      (SELECT links.route, links.subject_id, links.property, links.filter_value, links.order_key,
              links.target_subject_id AS sort_subject, links.statement_id AS sort_statement,
              links.slot_id, links.target_type, links.external, links.value, false AS suppressed, 0 AS layer
       FROM semantic.outbound_link AS links
       WHERE links.route = input.r_route AND links.subject_id = input.r_subject_id AND links.present AND links.relation
         AND links.context_id = '00000000-0000-8000-8000-000000000000'::uuid
         AND links.property = input.r_property AND links.filter_value = input.r_filter_value
         AND (links.order_key, links.target_subject_id, links.statement_id) > (input.r_after_order COLLATE "C", input.r_after_target, input.r_after_statement)
       ORDER BY links.order_key, links.target_subject_id, links.statement_id
       LIMIT 1)
      UNION ALL
      (SELECT links.route, links.subject_id, links.property, links.filter_value, links.order_key,
              links.target_subject_id AS sort_subject, links.statement_id AS sort_statement,
              links.slot_id, links.target_type, links.external, links.value, links.suppressed AS suppressed, 1 AS layer
       FROM semantic.outbound_link AS links
       WHERE links.route = input.r_route AND links.subject_id = input.r_subject_id AND links.present AND links.relation
         AND links.context_id = input.r_context_id AND input.r_context_id <> '00000000-0000-8000-8000-000000000000'::uuid
         AND links.property = input.r_property AND links.filter_value = input.r_filter_value
         AND (links.order_key, links.target_subject_id, links.statement_id) > (input.r_after_order COLLATE "C", input.r_after_target, input.r_after_statement)
       ORDER BY links.order_key, links.target_subject_id, links.statement_id
       LIMIT 1)
    ) candidates
    ORDER BY order_key, sort_subject, sort_statement, layer DESC
    LIMIT 1
  ) following
  UNION ALL
  SELECT following.*, page.selected_context, page.page_size, page.emitted + (NOT following.suppressed)::integer
  FROM page CROSS JOIN LATERAL (
    SELECT * FROM (
      (SELECT links.route, links.subject_id, links.property, links.filter_value, links.order_key,
              links.target_subject_id AS sort_subject, links.statement_id AS sort_statement,
              links.slot_id, links.target_type, links.external, links.value, false AS suppressed, 0 AS layer
       FROM semantic.outbound_link AS links
       WHERE links.route = page.route AND links.subject_id = page.subject_id AND links.present AND links.relation
         AND links.context_id = '00000000-0000-8000-8000-000000000000'::uuid
         AND links.property = page.property AND links.filter_value = page.filter_value
         AND (links.order_key, links.target_subject_id, links.statement_id) > (page.order_key, page.sort_subject, page.sort_statement)
       ORDER BY links.order_key, links.target_subject_id, links.statement_id
       LIMIT 1)
      UNION ALL
      (SELECT links.route, links.subject_id, links.property, links.filter_value, links.order_key,
              links.target_subject_id AS sort_subject, links.statement_id AS sort_statement,
              links.slot_id, links.target_type, links.external, links.value, links.suppressed AS suppressed, 1 AS layer
       FROM semantic.outbound_link AS links
       WHERE links.route = page.route AND links.subject_id = page.subject_id AND links.present AND links.relation
         AND links.context_id = page.selected_context AND page.selected_context <> '00000000-0000-8000-8000-000000000000'::uuid
         AND links.property = page.property AND links.filter_value = page.filter_value
         AND (links.order_key, links.target_subject_id, links.statement_id) > (page.order_key, page.sort_subject, page.sort_statement)
       ORDER BY links.order_key, links.target_subject_id, links.statement_id
       LIMIT 1)
    ) candidates
    ORDER BY order_key, sort_subject, sort_statement, layer DESC
    LIMIT 1
  ) following
  WHERE page.emitted < page.page_size
)
SELECT property, sort_statement::text AS statement, slot_id::text AS slot,
       NULLIF(sort_subject, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target,
       target_type AS type, external, value, order_key
FROM page
WHERE NOT suppressed
  AND property IS NOT NULL AND sort_statement IS NOT NULL AND slot_id IS NOT NULL
  AND target_type IS NOT NULL AND value IS NOT NULL AND order_key IS NOT NULL
ORDER BY order_key, sort_subject, sort_statement
LIMIT (SELECT r_page_limit FROM input);
