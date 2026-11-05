SELECT step, complete, handle, handle_key AS "handleKey"
FROM access.organization_close
WHERE route = :route AND organization_id = :organization_id
FOR UPDATE;
