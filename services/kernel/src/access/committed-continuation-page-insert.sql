WITH page AS (
  INSERT INTO access.operator_fence_page (route, continuation_id, page_key, cursor, next_cursor, allowlist)
  VALUES (:route, :continuation_id, :page_key, NULLIF(:cursor::text, ''), NULLIF(:next_cursor::text, ''), :allowlist::jsonb)
  RETURNING route, continuation_id, page_key, allowlist
), entries AS (
  INSERT INTO access.committed_continuation_entry (route, continuation_id, step, target, key, digest)
  SELECT page.route, page.continuation_id, entry->>'step', entry->>'target', entry->>'key', entry->>'digest'
  FROM page CROSS JOIN LATERAL jsonb_array_elements(page.allowlist) entry
  RETURNING continuation_id
)
SELECT page_key FROM page;
