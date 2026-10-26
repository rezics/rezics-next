WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT s.subject_id::text AS id, s.type,
       COALESCE(agent_subject.account_id, agent_node.account_id)::text AS agent_account_id,
       COALESCE(agent_subject.verified, agent_node.verified, false) AS agent_verified
FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS requested(route, id)
JOIN input ON requested.route >= input.partition_no * 16
          AND requested.route < (input.partition_no + 1) * 16
JOIN semantic.subject AS s
  ON s.route = requested.route
 AND s.subject_id = requested.id
 AND s.route >= input.partition_no * 16
 AND s.route < (input.partition_no + 1) * 16
 AND s.visibility = 'visible'
LEFT JOIN semantic.account_agent_subject AS agent_subject
  ON agent_subject.route = requested.route AND agent_subject.subject_id = requested.id
 AND agent_subject.route >= input.partition_no * 16
 AND agent_subject.route < (input.partition_no + 1) * 16
LEFT JOIN semantic.account_agent AS agent_node
  ON agent_node.route = requested.route AND agent_node.agent_id = requested.id
 AND agent_node.route >= input.partition_no * 16
 AND agent_node.route < (input.partition_no + 1) * 16;
