SELECT cursor, next_cursor AS "nextCursor", allowlist
FROM access.operator_fence_page
WHERE route = :route AND continuation_id = :continuation_id AND page_key = :page_key;
