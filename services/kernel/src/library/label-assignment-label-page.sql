-- Correlated bounded branches retain index predicates under generic prepared plans.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :label_id::uuid AS label_id,
         :after_subject_id::uuid AS after_subject_id, :limit::integer AS page_limit
), source AS MATERIALIZED (
  SELECT a.* FROM input CROSS JOIN LATERAL (
    SELECT assignment_id AS id, label_id AS "labelId", subject_id AS "subjectId", revision,
           slot_no AS "slotNo", deleted_at::text AS "deletedAt"
    FROM library.label_assignment
    WHERE route = input.route AND account_id = input.account_id AND label_id = input.label_id
      AND subject_id > input.after_subject_id
    ORDER BY subject_id LIMIT input.page_limit
  ) a
)
SELECT * FROM source ORDER BY "subjectId";
