WITH input AS NOT MATERIALIZED (SELECT :partition_no::integer AS partition_no),
requested AS NOT MATERIALIZED (
  SELECT route, id FROM jsonb_to_recordset(:subjects::jsonb) AS subject(route integer, id uuid)
)
SELECT requested.id::text AS id, representatives.slot_id::text AS slot_id, representatives.ordinal
FROM requested CROSS JOIN input
CROSS JOIN LATERAL (
  SELECT ordered.slot_id,
         row_number() OVER (ORDER BY ordered.order_key, ordered.target_subject_id, ordered.statement_id)::integer AS ordinal
  FROM (
    SELECT slot_id, order_key, target_subject_id, statement_id
    FROM semantic.outbound_link
    WHERE route = requested.route AND subject_id = requested.id
      AND context_id = '00000000-0000-8000-8000-000000000000'::uuid
      AND property = 'rezics:representativeEdition'
      AND filter_value = '00000000-0000-0000-0000-000000000000'::uuid AND present
      AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
    ORDER BY order_key, target_subject_id, statement_id
    LIMIT 12
  ) AS ordered
) AS representatives;
