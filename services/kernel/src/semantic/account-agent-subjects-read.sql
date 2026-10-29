WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT agent.account_id::text AS account, agent.account_route AS route, agent.route AS subject_route,
       agent.subject_id::text AS subject, agent.agent_id::text AS agent_id,
       agent.verified, agent.receipt_id
FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS requested(route, subject_id)
CROSS JOIN input
JOIN LATERAL (
  SELECT link.account_id, link.account_route, link.route, link.subject_id,
         link.agent_id, link.verified, link.receipt_id
  FROM semantic.account_agent_subject AS link
  WHERE link.route = requested.route AND link.subject_id = requested.subject_id
    AND link.route >= input.partition_no * 16
    AND link.route < (input.partition_no + 1) * 16
  -- A batch probes its keys; it must not hash unrelated links in the partition.
  OFFSET 0
) AS agent ON true;
