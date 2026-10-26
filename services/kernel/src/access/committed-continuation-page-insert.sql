INSERT INTO access.operator_fence_page (route, continuation_id, page_key, cursor, next_cursor, allowlist)
VALUES (:route, :continuation_id, :page_key, NULLIF(:cursor::text, ''), NULLIF(:next_cursor::text, ''), :allowlist::jsonb)
RETURNING page_key;
