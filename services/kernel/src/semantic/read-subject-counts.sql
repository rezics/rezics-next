WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id
)
SELECT direction, property, value::text
FROM (
  SELECT 'in'::text AS direction, property, value
  FROM semantic.inbound_link_count count_row CROSS JOIN input
  WHERE count_row.route = input.route AND count_row.subject_id = input.subject_id
    AND count_row.filter_value = '00000000-0000-0000-0000-000000000000'::uuid AND count_row.value > 0
  UNION ALL
  SELECT 'out'::text AS direction, property, value
  FROM semantic.outbound_link_count count_row CROSS JOIN input
  WHERE count_row.route = input.route AND count_row.subject_id = input.subject_id
    AND count_row.filter_value = '00000000-0000-0000-0000-000000000000'::uuid AND count_row.value > 0
) AS counts
ORDER BY direction, property;
