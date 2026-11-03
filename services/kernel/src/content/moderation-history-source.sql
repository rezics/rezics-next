WITH decision AS (
  SELECT decision_id, target_kind, target_id, decided_at
  FROM content.moderation_decision
  WHERE route = :route::integer AND target_kind = :target_kind::text
    AND target_id = :target_id::uuid AND security_revision = :security_revision::bigint
)
SELECT d.decision_id::text, d.target_kind, d.target_id::text,
       to_char(d.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at,
       COALESCE(t.author_account_id, p.author_account_id) AS author_account_id,
       COALESCE(t.thread_id, p.thread_id) AS thread_id, p.post_id,
       COALESCE(t.board_id, pt.board_id) AS board_id
FROM decision d
LEFT JOIN content.thread t
  ON d.target_kind = 'thread' AND t.route = :route::integer AND t.thread_id = d.target_id
LEFT JOIN content.post p
  ON d.target_kind = 'post' AND p.route = :route::integer AND p.post_id = d.target_id
LEFT JOIN content.thread pt ON pt.route = p.route AND pt.thread_id = p.thread_id;
