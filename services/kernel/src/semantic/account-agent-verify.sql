WITH input AS NOT MATERIALIZED (
  SELECT :account_id::uuid AS account_id, :account_route::integer AS account_route,
         :agent_id::uuid AS agent_id, :subject_id::uuid AS subject_id,
         :receipt_id::text AS receipt_id
), updated AS (
  UPDATE semantic.account_agent AS agent
  SET subject_id = input.subject_id, verified = true, receipt_id = input.receipt_id
  FROM input
  WHERE agent.route = input.account_route AND agent.account_id = input.account_id
    AND agent.agent_id = input.agent_id
    AND agent.subject_id = input.agent_id
    AND NOT agent.verified
  RETURNING agent.account_id::text AS account, agent.route,
            agent.subject_id::text AS subject, agent.agent_id::text AS agent_id,
            agent.verified, agent.receipt_id
)
SELECT * FROM updated;
