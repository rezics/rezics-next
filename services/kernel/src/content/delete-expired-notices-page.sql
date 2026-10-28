WITH page AS MATERIALIZED (
  SELECT ctid, notice_id
  FROM content.notice
  WHERE route = :route::integer AND created_at < :cutoff::timestamptz
  ORDER BY created_at, notice_id
  LIMIT 1000
  FOR UPDATE
)
DELETE FROM content.notice AS notice
USING page
WHERE notice.ctid = page.ctid
RETURNING notice.notice_id;
