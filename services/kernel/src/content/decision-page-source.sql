-- An exact retained decision and its current native placement, never target text.
SELECT d.decision_id, d.target_kind, d.target_id, d.action,
       CASE WHEN d.decider_account_id IS NULL AND d.decided_at + interval '183 days' <= CURRENT_TIMESTAMP
            THEN '' ELSE d.statement END AS statement,
       d.decided_at::text, a.appeal_id, a.outcome, a.resolver_statement, a.resolved_at::text,
       target.author_account_id, target.available,
       jsonb_build_array(
         d.route, d.decision_id, d.target_kind, d.target_id, d.action, d.statement,
         d.decider_account_id, d.decided_at, d.security_revision, d.recorded_transaction_id, d.board_id,
         a.appeal_id, a.decision_id, a.appellant_account_id, a.statement, a.thread_id, a.board_id,
         a.created_at, a.outcome, a.resolver_account_id, a.resolver_statement, a.resolved_at,
         target.witness
       )::text AS witness
FROM content.moderation_decision d
LEFT JOIN content.moderation_appeal a ON a.route = d.route AND a.decision_id = d.decision_id
JOIN LATERAL (
  SELECT NULL::uuid AS author_account_id, true AS available,
         jsonb_build_array(b.board_id, b.security_revision, b.visibility) AS witness
  FROM content.board b
  WHERE d.target_kind = 'board' AND b.route = d.route AND b.board_id = d.target_id
  UNION ALL
  SELECT t.author_account_id, t.availability = 'available',
         jsonb_build_array(t.thread_id, t.author_account_id, t.board_id, t.first_post_id,
                           t.security_revision, t.visibility, t.availability)
  FROM content.thread t
  WHERE d.target_kind = 'thread' AND t.route = d.route AND t.thread_id = d.target_id
  UNION ALL
  SELECT p.author_account_id, p.availability = 'available' AND t.availability = 'available',
         jsonb_build_array(p.post_id, p.author_account_id, p.thread_id, p.reply_to_post_id,
                           p.head_revision_id, p.security_revision, p.visibility, p.availability,
                           t.thread_id, t.board_id, t.first_post_id, t.security_revision,
                           t.visibility, t.availability)
  FROM content.post p
  JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
  WHERE d.target_kind = 'post' AND p.route = d.route AND p.post_id = d.target_id
) target ON true
WHERE d.route = :route::integer AND d.decision_id = :decision_id::uuid;
