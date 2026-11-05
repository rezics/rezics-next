WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id,
  :generation::uuid AS generation,:before::boolean AS before), keys AS MATERIALIZED (
  (SELECT generation_id,reservation_id,octet_length(full_type)::bigint+COALESCE(octet_length(input_bytes),0)::bigint AS bytes
   FROM library.shelf_type_reservation
   WHERE route=(SELECT route FROM input) AND account_id=(SELECT account_id FROM input)
     AND (SELECT before FROM input) AND generation_id<(SELECT generation FROM input)
   ORDER BY generation_id,reservation_id LIMIT 100)
  UNION ALL
  (SELECT generation_id,reservation_id,octet_length(full_type)::bigint+COALESCE(octet_length(input_bytes),0)::bigint AS bytes
   FROM library.shelf_type_reservation
   WHERE route=(SELECT route FROM input) AND account_id=(SELECT account_id FROM input)
     AND NOT (SELECT before FROM input) AND generation_id>(SELECT generation FROM input)
   ORDER BY generation_id,reservation_id LIMIT 100)
)
SELECT COALESCE(sum(bytes),0)::text AS bytes FROM keys;
