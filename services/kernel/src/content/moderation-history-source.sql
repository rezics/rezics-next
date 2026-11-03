WITH input AS (
  SELECT :route::integer AS route, :target_kind::text AS target_kind,
         :target_id::uuid AS target_id, :security_revision::bigint AS security_revision
), decision AS (
  SELECT d.decision_id, d.target_kind, d.target_id, d.decided_at, i.route
  FROM content.moderation_decision d CROSS JOIN input i
  WHERE d.route = i.route AND d.target_kind = i.target_kind
    AND d.target_id = i.target_id AND d.security_revision = i.security_revision
)
SELECT d.decision_id::text, d.target_kind, d.target_id::text,
       to_char(d.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at,
       COALESCE(t.author_account_id, p.author_account_id) AS author_account_id,
       COALESCE(t.thread_id, p.thread_id) AS thread_id, p.post_id,
       COALESCE(t.board_id, pt.board_id) AS board_id
FROM decision d
LEFT JOIN content.thread t
  ON d.target_kind = 'thread' AND t.route = d.route AND t.thread_id = d.target_id
LEFT JOIN content.post p
  ON d.target_kind = 'post' AND p.route = d.route AND p.post_id = d.target_id
LEFT JOIN content.thread pt ON pt.route = p.route AND pt.thread_id = p.thread_id;
