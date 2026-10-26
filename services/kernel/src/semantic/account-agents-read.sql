WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT requested.account_id::text AS account, agent.subject_id::text AS subject
FROM unnest(:routes::integer[], :account_ids::uuid[]) AS requested(route, account_id)
CROSS JOIN input
LEFT JOIN semantic.account_agent AS agent
  ON agent.route = requested.route AND agent.account_id = requested.account_id
 AND agent.route >= input.partition_no * 16
 AND agent.route < (input.partition_no + 1) * 16
WHERE requested.route >= input.partition_no * 16
  AND requested.route < (input.partition_no + 1) * 16;
