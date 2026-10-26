WITH input AS NOT MATERIALIZED (
  SELECT :receipt_id::text AS receipt_id, :account_id::uuid AS account_id,
         :survivor::uuid AS survivor, :moved_from::uuid AS moved_from,
         :links::jsonb AS links
)
INSERT INTO semantic.account_agent_moved_link (route, receipt_id, account_id, survivor, moved_from, statement_id)
SELECT :route, input.receipt_id, input.account_id, input.survivor, input.moved_from, link.statement_id
FROM input
CROSS JOIN LATERAL jsonb_to_recordset(input.links) AS link(statement_id uuid, receipt_id text, account_id uuid)
WHERE link.receipt_id = input.receipt_id AND link.account_id = input.account_id
ON CONFLICT (route, receipt_id, moved_from, statement_id) DO NOTHING;
