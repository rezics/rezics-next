INSERT INTO content.notice_finalization (route, recipient_id, kind, source_id, sent, created_at)
VALUES (:route::integer, :recipient_id::uuid, :kind::text, :source_id::uuid, :sent::boolean, :created_at::timestamptz)
ON CONFLICT DO NOTHING
RETURNING sent;
