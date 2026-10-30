WITH page AS MATERIALIZED (
  SELECT route, recipient_id, kind, source_id
  FROM content.notice_finalization
  WHERE route = :route::integer AND created_at < :cutoff::timestamptz
  ORDER BY created_at, recipient_id, kind, source_id
  LIMIT :limit::integer
  FOR UPDATE
)
DELETE FROM content.notice_finalization AS outcome
USING page
WHERE (outcome.route, outcome.recipient_id, outcome.kind, outcome.source_id)
    = (page.route, page.recipient_id, page.kind, page.source_id)
RETURNING outcome.source_id;
