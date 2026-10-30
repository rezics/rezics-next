SELECT sent FROM content.notice_finalization
WHERE route = :route::integer AND recipient_id = :recipient_id::uuid
  AND kind = :kind::text AND source_id = :source_id::uuid;
