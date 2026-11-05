WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :property::text AS property, :filter_value::uuid AS filter_value, :context_id::uuid AS context_id
)
SELECT (COALESCE(base.value, 0) + COALESCE(local.value, 0))::text AS value
FROM input
LEFT JOIN semantic.inbound_link_count base
  ON base.route = input.route AND base.subject_id = input.subject_id
 AND base.context_id = '00000000-0000-8000-8000-000000000000'
 AND base.property = input.property AND base.filter_value = input.filter_value
LEFT JOIN semantic.inbound_link_context_count local
  ON local.route = input.route AND local.subject_id = input.subject_id
 AND local.context_id = input.context_id
 AND local.property = input.property AND local.filter_value = input.filter_value;
