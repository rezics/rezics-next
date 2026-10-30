SELECT had_data AS "hadData", cursor_id AS cursor, phase, blocker
FROM commerce.erasure_progress
WHERE route = :route::integer AND account_id = :account_id::uuid
FOR UPDATE;
