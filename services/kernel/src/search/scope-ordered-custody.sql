WITH input AS (
  SELECT :partition::integer AS partition_no,:observation::text AS observation,:pit_id::text AS pit_id
)
SELECT o.queried,o.state,o.expires_at,p.locator,p.state AS pit_state
FROM input
LEFT JOIN search.public_filter_observation o
  ON (o.partition_no,o.observation)=(input.partition_no,input.observation)
LEFT JOIN search.public_filter_pit p
  ON (p.partition_no,p.observation,p.id)=(input.partition_no,input.observation,input.pit_id);
