-- An exact retained decision and its current native placement, never target text.
SELECT d.decision_id, d.target_kind, d.target_id, d.action,
       CASE WHEN d.decider_account_id IS NULL AND d.decided_at + interval '183 days' <= CURRENT_TIMESTAMP
            THEN '' ELSE d.statement END AS statement,
       d.decided_at::text, a.appeal_id, a.outcome, a.resolver_statement, a.resolved_at::text,
       CASE WHEN d.target_kind = 'thread' THEN t.author_account_id
            WHEN d.target_kind = 'post' THEN p.author_account_id END AS author_account_id,
       CASE WHEN d.target_kind = 'board' THEN true
            WHEN d.target_kind = 'thread' THEN t.availability = 'available'
            ELSE p.availability = 'available' AND parent.availability = 'available' END AS available,
       jsonb_build_array(
         d.route, d.decision_id, d.target_kind, d.target_id, d.action, d.statement,
         d.decider_account_id, d.decided_at, d.security_revision, d.recorded_transaction_id, d.board_id,
         a.appeal_id, a.decision_id, a.appellant_account_id, a.statement, a.thread_id, a.board_id,
         a.created_at, a.outcome, a.resolver_account_id, a.resolver_statement, a.resolved_at,
         CASE d.target_kind
           WHEN 'board' THEN jsonb_build_array(b.board_id, b.security_revision, b.visibility)
           WHEN 'thread' THEN jsonb_build_array(t.thread_id, t.author_account_id, t.board_id, t.first_post_id,
                                               t.security_revision, t.visibility, t.availability)
           ELSE jsonb_build_array(p.post_id, p.author_account_id, p.thread_id, p.reply_to_post_id,
                                  p.head_revision_id, p.security_revision, p.visibility, p.availability,
                                  parent.thread_id, parent.board_id, parent.first_post_id,
                                  parent.security_revision, parent.visibility, parent.availability)
         END
       )::text AS witness
FROM content.moderation_decision d
LEFT JOIN content.moderation_appeal a ON a.route = d.route AND a.decision_id = d.decision_id
LEFT JOIN content.board b
  ON d.target_kind = 'board' AND b.route = d.route AND b.board_id = d.target_id
LEFT JOIN content.thread t
  ON d.target_kind = 'thread' AND t.route = d.route AND t.thread_id = d.target_id
LEFT JOIN content.post p
  ON d.target_kind = 'post' AND p.route = d.route AND p.post_id = d.target_id
LEFT JOIN content.thread parent
  ON d.target_kind = 'post' AND parent.route = p.route AND parent.thread_id = p.thread_id
WHERE d.route = :route::integer AND d.decision_id = :decision_id::uuid
  AND ((d.target_kind = 'board' AND b.board_id IS NOT NULL)
    OR (d.target_kind = 'thread' AND t.thread_id IS NOT NULL)
    OR (d.target_kind = 'post' AND p.post_id IS NOT NULL AND parent.thread_id IS NOT NULL));
