DELETE FROM content.notice_seen
WHERE route = :route::integer AND account_id = :account_id::uuid
RETURNING account_id;
