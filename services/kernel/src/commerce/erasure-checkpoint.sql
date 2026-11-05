UPDATE commerce.erasure_progress SET cursor_id = :cursor::uuid, phase = :phase::text, blocker = NULLIF(:blocker::text, '')
WHERE route = :route::integer AND account_id = :account_id::uuid;
