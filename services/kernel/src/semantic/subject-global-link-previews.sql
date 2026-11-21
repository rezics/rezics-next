-- Global links have no overriding layer. Seek each declared relation independently
-- so a large property cannot consume another property's preview or sentinel.
SELECT wanted.property, payload.slot_id::text AS slot, page.statement_id::text AS statement,
       NULLIF(page.target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target,
       payload.external, payload.value, page.order_key
FROM unnest(:properties::text[]) AS wanted(property)
CROSS JOIN LATERAL (
  SELECT links.route, links.subject_id, links.statement_id, links.target_subject_id, links.order_key
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
-- The live-key index also carries relation. Read payloads after applying the per-property limit.
JOIN semantic.outbound_link AS payload
  ON payload.route = page.route AND payload.subject_id = page.subject_id
 AND payload.context_id = '00000000-0000-8000-8000-000000000000'::uuid
 AND payload.property = wanted.property AND payload.filter_value = '00000000-0000-0000-0000-000000000000'::uuid
 -- An exact range keeps all three cursor fields on the primary key, including after an order change.
 AND (payload.order_key, payload.target_subject_id, payload.statement_id) BETWEEN
     (page.order_key, page.target_subject_id, page.statement_id) AND
     (page.order_key, page.target_subject_id, page.statement_id)
ORDER BY wanted.property, page.order_key, page.target_subject_id, page.statement_id;
