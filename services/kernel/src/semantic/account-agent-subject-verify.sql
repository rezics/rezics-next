WITH input AS NOT MATERIALIZED (
  SELECT :account_id::uuid AS account_id, :agent_id::uuid AS agent_id,
         :account_route::integer AS account_route, :node_route::integer AS node_route,
         :catalogue::uuid AS catalogue, :receipt_id::text AS receipt_id
)
UPDATE semantic.account_agent_subject AS agent
SET route = get_byte(uuid_send(input.catalogue), 10) * 256 + get_byte(uuid_send(input.catalogue), 11),
    subject_id = input.catalogue, verified = true, receipt_id = input.receipt_id
FROM input
WHERE agent.route = input.node_route AND agent.subject_id = input.agent_id
  AND agent.account_route = input.account_route
  AND agent.account_id = input.account_id AND agent.agent_id = input.agent_id
  AND NOT agent.verified
RETURNING agent.account_id::text AS account, agent.route, agent.account_route,
          agent.subject_id::text AS subject, agent.agent_id::text AS agent_id,
          agent.verified, agent.receipt_id;
