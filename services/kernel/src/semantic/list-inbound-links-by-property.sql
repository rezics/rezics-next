-- Merge one payload-bearing seek per layer, preferring Context at an equal cursor.
-- Advance past suppressed keys without spending the visible page's sentinel budget.
WITH RECURSIVE input AS (
  SELECT :route::integer AS r_route, :subject_id::uuid AS r_subject_id,
         :context_id::uuid AS r_context_id, :property::text AS r_property,
         :filter_value::uuid AS r_filter_value, :after_order::text AS r_after_order,
         :after_source::uuid AS r_after_source, :after_statement::uuid AS r_after_statement,
         :page_limit::integer AS r_page_limit, :scan_limit::integer AS r_scan_limit
), page AS (
  SELECT following.*, input.r_context_id AS selected_context, input.r_page_limit AS page_size,
         input.r_scan_limit AS scan_limit, (NOT following.suppressed)::integer AS emitted, 1 AS examined
  FROM input CROSS JOIN LATERAL (
    SELECT * FROM (
      (SELECT links.route, links.subject_id, links.property, links.filter_value, links.order_key,
              links.source_subject_id AS sort_subject, links.statement_id AS sort_statement,
              links.source_type, false AS suppressed, 0 AS layer
       FROM semantic.inbound_link AS links
       WHERE links.route = input.r_route AND links.subject_id = input.r_subject_id AND links.present
         AND links.context_id = '00000000-0000-8000-8000-000000000000'::uuid
         AND links.property = input.r_property AND links.filter_value = input.r_filter_value
         AND (links.order_key, links.source_subject_id, links.statement_id) > (input.r_after_order COLLATE "C", input.r_after_source, input.r_after_statement)
       ORDER BY links.order_key, links.source_subject_id, links.statement_id
       LIMIT 1)
      UNION ALL
      (SELECT links.route, links.subject_id, links.property, links.filter_value, links.order_key,
              links.source_subject_id AS sort_subject, links.statement_id AS sort_statement,
              links.source_type, links.suppressed AS suppressed, 1 AS layer
       FROM semantic.inbound_link AS links
       WHERE links.route = input.r_route AND links.subject_id = input.r_subject_id AND links.present
         AND links.context_id = input.r_context_id AND input.r_context_id <> '00000000-0000-8000-8000-000000000000'::uuid
         AND links.property = input.r_property AND links.filter_value = input.r_filter_value
         AND (links.order_key, links.source_subject_id, links.statement_id) > (input.r_after_order COLLATE "C", input.r_after_source, input.r_after_statement)
       ORDER BY links.order_key, links.source_subject_id, links.statement_id
       LIMIT 1)
    ) candidates
    ORDER BY order_key, sort_subject, sort_statement, layer DESC
    LIMIT 1
  ) following
  UNION ALL
  SELECT following.*, page.selected_context, page.page_size, page.scan_limit,
         page.emitted + (NOT following.suppressed)::integer, page.examined + 1
  FROM page CROSS JOIN LATERAL (
    SELECT * FROM (
      (SELECT links.route, links.subject_id, links.property, links.filter_value, links.order_key,
              links.source_subject_id AS sort_subject, links.statement_id AS sort_statement,
              links.source_type, false AS suppressed, 0 AS layer
       FROM semantic.inbound_link AS links
       WHERE links.route = page.route AND links.subject_id = page.subject_id AND links.present
         AND links.context_id = '00000000-0000-8000-8000-000000000000'::uuid
         AND links.property = page.property AND links.filter_value = page.filter_value
         AND (links.order_key, links.source_subject_id, links.statement_id) > (page.order_key, page.sort_subject, page.sort_statement)
       ORDER BY links.order_key, links.source_subject_id, links.statement_id
       LIMIT 1)
      UNION ALL
      (SELECT links.route, links.subject_id, links.property, links.filter_value, links.order_key,
              links.source_subject_id AS sort_subject, links.statement_id AS sort_statement,
              links.source_type, links.suppressed AS suppressed, 1 AS layer
       FROM semantic.inbound_link AS links
       WHERE links.route = page.route AND links.subject_id = page.subject_id AND links.present
         AND links.context_id = page.selected_context AND page.selected_context <> '00000000-0000-8000-8000-000000000000'::uuid
         AND links.property = page.property AND links.filter_value = page.filter_value
         AND (links.order_key, links.source_subject_id, links.statement_id) > (page.order_key, page.sort_subject, page.sort_statement)
       ORDER BY links.order_key, links.source_subject_id, links.statement_id
       LIMIT 1)
    ) candidates
    ORDER BY order_key, sort_subject, sort_statement, layer DESC
    LIMIT 1
  ) following
  WHERE page.emitted < page.page_size
    AND (page.scan_limit IS NULL OR page.examined < page.scan_limit)
), last AS (
  SELECT * FROM page ORDER BY examined DESC LIMIT 1
), summary AS (
  SELECT COALESCE(MAX(examined), 0) AS examined, MAX(scan_limit) AS scan_limit FROM page
), following AS (
  SELECT
    EXISTS (
      SELECT 1 FROM semantic.inbound_link links CROSS JOIN last
      WHERE links.route = (SELECT r_route FROM input)
        AND links.subject_id = (SELECT r_subject_id FROM input) AND links.present
        AND links.context_id = '00000000-0000-8000-8000-000000000000'::uuid
        AND links.property = (SELECT r_property FROM input)
        AND links.filter_value = (SELECT r_filter_value FROM input)
        AND (links.order_key, links.source_subject_id, links.statement_id) >
            (last.order_key COLLATE "C", last.sort_subject, last.sort_statement)
      LIMIT 1
    ) OR EXISTS (
      SELECT 1 FROM semantic.inbound_link links CROSS JOIN last
      WHERE links.route = (SELECT r_route FROM input)
        AND links.subject_id = (SELECT r_subject_id FROM input) AND links.present
        AND links.context_id = (SELECT r_context_id FROM input)
        AND (SELECT r_context_id FROM input) <> '00000000-0000-8000-8000-000000000000'::uuid
        AND links.property = (SELECT r_property FROM input)
        AND links.filter_value = (SELECT r_filter_value FROM input)
        AND (links.order_key, links.source_subject_id, links.statement_id) >
            (last.order_key COLLATE "C", last.sort_subject, last.sort_statement)
      LIMIT 1
    ) AS has_more
), status AS (
  SELECT
    summary.scan_limit IS NOT NULL AND summary.examined >= summary.scan_limit AND following.has_more AS scan_capped,
    last.order_key AS scan_after_order,
    last.sort_subject::text AS scan_after_source,
    last.sort_statement::text AS scan_after_statement
  FROM summary CROSS JOIN following LEFT JOIN last ON true
)
SELECT property, sort_subject::text AS subject, sort_statement::text AS statement,
       source_type AS type, order_key, status.scan_capped, status.scan_after_order,
       status.scan_after_source, status.scan_after_statement, false AS metadata_only
FROM page CROSS JOIN status
WHERE NOT suppressed
  AND property IS NOT NULL AND sort_subject IS NOT NULL AND sort_statement IS NOT NULL
  AND source_type IS NOT NULL AND order_key IS NOT NULL
UNION ALL
SELECT NULL::text AS property, NULL::text AS subject, NULL::text AS statement,
       NULL::text AS type, NULL::text AS order_key, status.scan_capped, status.scan_after_order,
       status.scan_after_source, status.scan_after_statement, true AS metadata_only
FROM status
ORDER BY metadata_only, order_key, subject, statement
LIMIT (SELECT r_page_limit + 1 FROM input);
