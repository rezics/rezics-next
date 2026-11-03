SELECT p.post_id, p.thread_id
FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, id uuid)
CROSS JOIN LATERAL (
  SELECT post_id, thread_id FROM content.post
  WHERE route=k.route AND post_id=k.id LIMIT 1
) p;
