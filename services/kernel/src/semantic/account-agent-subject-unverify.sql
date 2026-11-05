WITH input AS NOT MATERIALIZED (
  SELECT :node_route::integer AS node_route, :catalogue_route::integer AS catalogue_route,
         :account_route::integer AS account_route, :account_id::uuid AS account_id,
         :agent_id::uuid AS agent_id, :catalogue::uuid AS catalogue,
         :verification_receipt_id::text AS verification_receipt_id
)
UPDATE semantic.account_agent_subject AS agent
SET route = input.node_route,
    subject_id = input.agent_id,
    verified = false,
    receipt_id = NULL
FROM input
WHERE agent.route = input.catalogue_route AND agent.subject_id = input.catalogue
  AND agent.account_route = input.account_route AND agent.account_id = input.account_id
  AND agent.agent_id = input.agent_id AND agent.verified
  AND agent.receipt_id = input.verification_receipt_id
RETURNING agent.account_id::text AS account, agent.route, agent.account_route,
          agent.subject_id::text AS subject, agent.agent_id::text AS agent_id,
          agent.verified, agent.receipt_id;
