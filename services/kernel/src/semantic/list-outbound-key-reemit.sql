-- Seek each next cursor tuple so a low holder-cardinality estimate cannot sort its entire range before LIMIT.
-- Carry the payload in the seek itself to avoid a second hydration probe for each emitted row.
WITH RECURSIVE page AS (
  (
    SELECT links.*, 1 AS ordinal
    FROM semantic.outbound_link AS links
    WHERE route = :route::integer AND subject_id = :subject_id::uuid AND present AND relation
      AND (property, target_subject_id, statement_id, filter_value, context_id) >
        (:after_property::text, :after_target::uuid, :after_statement::uuid, :after_filter::uuid, :after_context::uuid)
    ORDER BY links.property, links.target_subject_id, links.statement_id, links.filter_value, links.context_id
    LIMIT 1
  )
  UNION ALL
  SELECT following.*, page.ordinal + 1
  FROM page
  CROSS JOIN LATERAL (
    SELECT links.*
    FROM semantic.outbound_link AS links
    WHERE links.route = page.route AND links.subject_id = page.subject_id AND links.present AND links.relation
      AND (links.property, links.target_subject_id, links.statement_id, links.filter_value, links.context_id) >
        (page.property, page.target_subject_id, page.statement_id, page.filter_value, page.context_id)
    ORDER BY links.property, links.target_subject_id, links.statement_id, links.filter_value, links.context_id
    LIMIT 1
  ) AS following
  WHERE page.ordinal < 101
)
SELECT context_id::text, suppressed, property, statement_id::text AS statement_id, slot_id::text AS slot_id,
       NULLIF(target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target,
       filter_value::text, order_key, relation, source_type, source_order_key,
       outbound_order, source_revision, source_security_revision::text, target_revision,
       target_type, external, value
FROM page AS links
ORDER BY links.property, links.target_subject_id, links.statement_id, links.filter_value, links.context_id
LIMIT 101;
