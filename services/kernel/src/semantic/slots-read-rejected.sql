SELECT * FROM (
  SELECT c.*, a.revision AS decision_revision
  FROM (SELECT :route::integer AS route) AS input
  JOIN semantic.acceptance_current a ON a.route = input.route
  JOIN LATERAL (
    SELECT * FROM semantic.candidate
    WHERE route = input.route AND subject_id = a.subject_id AND candidate_id = a.candidate_id
    LIMIT 1
  ) c ON true
  WHERE a.subject_id = :subject_id::uuid AND a.context_id = :context_id::uuid AND a.slot_id = :slot_id::uuid
    AND a.verdict = 'reject'
  ORDER BY a.revision DESC, a.candidate_id
  LIMIT :rejected_limit::integer
) recent
WHERE NOT (candidate_id = ANY(:excluded::uuid[]))
ORDER BY revision, view_order, candidate_id;
