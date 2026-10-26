WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT agent.account_id::text AS account, agent.account_route AS route, agent.route AS subject_route,
       agent.subject_id::text AS subject, agent.agent_id::text AS agent_id,
       agent.verified, agent.receipt_id
FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS requested(route, subject_id)
CROSS JOIN input
JOIN semantic.account_agent_subject AS agent
  ON agent.route = requested.route AND agent.subject_id = requested.subject_id
 AND agent.route >= input.partition_no * 16
 AND agent.route < (input.partition_no + 1) * 16;
