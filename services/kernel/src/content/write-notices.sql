WITH input AS NOT MATERIALIZED (
  SELECT :partition::integer AS partition
)
INSERT INTO content.notice (
  route, recipient_id, notice_id, kind, actor_id, thread_id, post_id,
  decision_id, report_id, source_id, created_at
)
SELECT item.route, item.recipient_id, item.notice_id, item.kind, item.actor_id, item.thread_id, item.post_id,
       item.decision_id, item.report_id, item.source_id, item.created_at
FROM jsonb_to_recordset(:notices::jsonb) AS item(
  route integer,
  recipient_id uuid,
  notice_id uuid,
  kind text,
  actor_id uuid,
  thread_id uuid,
  post_id uuid,
  decision_id uuid,
  report_id uuid,
  source_id uuid,
  created_at timestamptz
)
CROSS JOIN input
WHERE item.route >= input.partition * 16
  AND item.route < (input.partition + 1) * 16
ON CONFLICT DO NOTHING
RETURNING notice_id;
