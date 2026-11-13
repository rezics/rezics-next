-- Keep a collection result (zero or one rows) for an exact revision lookup.
SELECT r.route, r.thread_id, r.post_id, r.revision_id, r.body, r.body_sha256, r.search_text,
       r.licence, r.subject_ids, r.board_id, r.availability, r.recorded_transaction_id, r.recorded_at,
       rr.mode AS revision_restriction, rr.decision_id AS revision_restriction_decision_id
FROM content.revision r
LEFT JOIN content.post_revision_restriction rr
  ON rr.route = r.route AND rr.revision_id = r.revision_id AND rr.lifted_at IS NULL
WHERE r.route = :route::integer AND r.thread_id = :thread_id::uuid
  AND r.post_id = :post_id::uuid AND r.revision_id = ANY (ARRAY[:revision_id::uuid]);
