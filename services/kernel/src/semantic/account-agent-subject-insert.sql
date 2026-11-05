INSERT INTO semantic.account_agent_subject (route, account_route, subject_id, account_id, agent_id)
VALUES (:route, :account_route::integer, :subject_id::uuid, :account_id::uuid, :agent_id::uuid)
ON CONFLICT (route, subject_id) DO NOTHING
RETURNING account_id::text AS account, route, subject_id::text AS subject,
          agent_id::text AS agent_id, verified, receipt_id;
