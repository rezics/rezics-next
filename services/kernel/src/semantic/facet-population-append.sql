WITH input AS NOT MATERIALIZED (
  SELECT $1::integer AS partition_no, $2::uuid AS frontier, $3::uuid AS predecessor,
    $4::text AS observation, $5::text AS binding, $6::text AS capture, $7::jsonb AS state,
    $8::jsonb AS subjects, $9::boolean AS complete, $10::bigint AS expires, $11::integer AS epoch
)
INSERT INTO semantic.facet_population_frontier
  (partition_no, frontier, predecessor, observation, binding, capture, state, subjects, complete, expires)
SELECT input.partition_no, frontier, predecessor, observation, binding, capture, state, subjects, complete, expires
FROM input
WHERE EXISTS (SELECT 1 FROM core.partition WHERE partition_no = input.partition_no
  AND epoch = input.epoch AND write_state = 'active')
ON CONFLICT (partition_no, predecessor) WHERE predecessor IS NOT NULL DO NOTHING
RETURNING frontier::text, observation, binding, capture, state, subjects, complete, expires::text;
