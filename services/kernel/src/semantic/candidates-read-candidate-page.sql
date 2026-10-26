WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route
)
SELECT c.*, a.verdict, a.head
FROM input
CROSS JOIN LATERAL (
  SELECT * FROM semantic.candidate
  WHERE route = input.route AND subject_id = :subject_id::uuid AND slot_id = :slot_id::uuid
    AND (revision, view_order, candidate_id) > (:after_revision::integer, :after_view_order::integer, :after_candidate_id::uuid)
  ORDER BY revision, view_order, candidate_id
  LIMIT :page_limit::integer
) c
LEFT JOIN semantic.acceptance_current a
  ON a.route = input.route AND a.subject_id = c.subject_id AND a.context_id = :context_id::uuid
    AND a.candidate_id = c.candidate_id
ORDER BY c.revision, c.view_order, c.candidate_id;
