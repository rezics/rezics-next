-- One home: current subject heads and at most four present Global copy/release-to-work locators.
-- Four locators are lookahead. Projection rows are never statement or completeness authority.
WITH input AS MATERIALIZED (
  SELECT :partition_no::integer AS home, :property::text AS property, :page_limit::integer AS page_limit
),
wanted AS (
  SELECT wanted.route, wanted.subject_id
  FROM jsonb_to_recordset(:wanted::jsonb) AS wanted(route integer, subject_id uuid)
)
SELECT s.subject_id::text AS id, s.type, s.visibility,
       s.security_revision::text AS security, s.current_release AS release,
       r.revision, basis.epoch AS source_epoch, basis.position::text AS source_position,
       redirect.target::text AS redirect,
       link.statement_id::text AS candidate, link.slot_id::text AS slot,
       NULLIF(link.target_subject_id, '00000000-0000-0000-0000-000000000000'::uuid)::text AS target,
       link.target_type, link.order_key, link.source_revision,
       link.source_security_revision::text AS source_security_revision, link.value
FROM wanted
CROSS JOIN input
JOIN LATERAL (
  SELECT subject_id, type, visibility, security_revision, current_release
  FROM semantic.subject
  WHERE route = wanted.route AND subject_id = wanted.subject_id
    AND route >= input.home * 16 AND route < (input.home + 1) * 16
  LIMIT 1
) s ON true
LEFT JOIN LATERAL (
  SELECT revision, recorded_transaction_id
  FROM semantic.revision
  WHERE route = wanted.route AND subject_id = wanted.subject_id
    AND route >= input.home * 16 AND route < (input.home + 1) * 16
  ORDER BY revision DESC
  LIMIT 1
) r ON true
LEFT JOIN LATERAL (
  SELECT epoch, position
  FROM editorial.write_basis
  WHERE partition_no = input.home AND transaction_id = r.recorded_transaction_id
  LIMIT 1
) basis ON true
LEFT JOIN LATERAL (
  SELECT target
  FROM semantic.redirect
  WHERE route = wanted.route AND subject_id = wanted.subject_id
    AND route >= input.home * 16 AND route < (input.home + 1) * 16
  ORDER BY sequence DESC
  LIMIT 1
) redirect ON true
LEFT JOIN LATERAL (
  SELECT statement_id, slot_id, target_subject_id, target_type, order_key,
         source_revision, source_security_revision, value
  FROM semantic.outbound_link
  WHERE route = wanted.route AND subject_id = wanted.subject_id
    AND route >= input.home * 16 AND route < (input.home + 1) * 16
    AND property = input.property
    AND context_id = '00000000-0000-8000-8000-000000000000'::uuid
    AND filter_value = '00000000-0000-0000-0000-000000000000'::uuid
    AND relation AND present
  ORDER BY order_key, target_subject_id, statement_id
  LIMIT input.page_limit
) link ON true
ORDER BY s.subject_id, link.order_key, link.target_subject_id, link.statement_id;
