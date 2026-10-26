INSERT INTO semantic.moderation
(route, subject_id, security_revision, action, visibility, actor, body, recorded_transaction_id, candidate_id)
VALUES (
  :route::integer, :subject_id::uuid, :security_revision::bigint, :action::text, :visibility::text,
  :actor::uuid, :body::jsonb, :transaction_id::uuid, :candidate_id::uuid
);
