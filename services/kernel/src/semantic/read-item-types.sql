WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT s.subject_id::text AS id, s.type,
       agent_subject.account_id::text AS agent_account_id,
       COALESCE(agent_subject.verified, false) AS agent_verified
FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS requested(route, id)
JOIN input ON requested.route >= input.partition_no * 16
          AND requested.route < (input.partition_no + 1) * 16
JOIN semantic.subject AS s
  ON s.route = requested.route
 AND s.subject_id = requested.id
 AND s.route >= input.partition_no * 16
 AND s.route < (input.partition_no + 1) * 16
 AND s.visibility = 'visible'
LEFT JOIN LATERAL (
  SELECT agent.account_id, agent.verified
  FROM semantic.account_agent_subject AS agent
  WHERE agent.route = requested.route AND agent.subject_id = requested.id
    AND agent.route >= input.partition_no * 16
    AND agent.route < (input.partition_no + 1) * 16
  -- Keep each ownership read correlated to its requested key, including absent links.
  OFFSET 0
) AS agent_subject ON true;
