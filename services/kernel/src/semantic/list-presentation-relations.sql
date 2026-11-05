-- The native ordered Global relation range supplies only candidate locators.
-- The caller proves checkpoint coverage and rereads each locator's actual selected slot.
SELECT wanted.id::text AS id, wanted.property, link.slot_id::text AS slot,
       link.statement_id::text AS candidate, link.order_key, link.source_revision, link.source_security_revision::text
FROM jsonb_to_recordset($1::jsonb) wanted(route integer, id uuid, property text)
CROSS JOIN LATERAL (
  SELECT slot_id, statement_id, order_key, target_subject_id, source_revision, source_security_revision
  FROM semantic.outbound_link
  WHERE route=wanted.route AND subject_id=wanted.id AND property=wanted.property
    AND context_id='00000000-0000-8000-8000-000000000000'::uuid
    AND filter_value='00000000-0000-0000-0000-000000000000'::uuid
    AND relation AND present
  ORDER BY order_key, target_subject_id, statement_id
  LIMIT $2::integer
) link
ORDER BY wanted.id, wanted.property, link.order_key, link.target_subject_id, link.statement_id;
