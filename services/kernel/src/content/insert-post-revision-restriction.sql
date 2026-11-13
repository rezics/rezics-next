INSERT INTO content.post_revision_restriction
  (route, decision_id, thread_id, post_id, revision_id, mode, security_revision, restricted_at)
VALUES (:route::integer, :decision_id::uuid, :thread_id::uuid, :post_id::uuid, :revision_id::uuid,
        :mode::text, :security_revision::bigint, :restricted_at::timestamptz);
