INSERT INTO semantic.account_agent (account_id, route, subject_id, agent_id)
VALUES (:account_id::uuid, :route, :subject_id::uuid, :agent_id::uuid)
ON CONFLICT (route, account_id) DO NOTHING
RETURNING account_id::text AS account, route, subject_id::text AS subject,
          agent_id::text AS agent_id, verified, receipt_id;
