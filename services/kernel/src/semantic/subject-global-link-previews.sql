-- Global links have no overriding layer. Seek each declared relation independently
-- so a large property cannot consume another property's preview or sentinel.
SELECT wanted.property, page.slot_id::text AS slot, page.statement_id::text AS statement,
       NULLIF(page.target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target,
       page.external, page.value, page.order_key
FROM unnest(:properties::text[]) AS wanted(property)
CROSS JOIN LATERAL (
  SELECT links.slot_id, links.statement_id, links.target_subject_id, links.external, links.value, links.order_key
  FROM semantic.outbound_link AS links
  WHERE links.route = :route::integer AND links.subject_id = :subject_id::uuid
    AND links.present AND links.relation
    AND links.context_id = '00000000-0000-8000-8000-000000000000'::uuid
    AND links.property = wanted.property AND links.filter_value = '00000000-0000-0000-0000-000000000000'::uuid
    AND (links.order_key, links.target_subject_id, links.statement_id) >
        ('' COLLATE "C", '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
  ORDER BY links.order_key, links.target_subject_id, links.statement_id
  LIMIT :page_limit::integer
) AS page
ORDER BY wanted.property, page.order_key, page.target_subject_id, page.statement_id;
