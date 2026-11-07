-- Correlated reserved-source seeks retain the partial index under generic prepared plans.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :subject_id::uuid AS subject_id
)
SELECT a.assignment_id AS id, a.label_id AS "labelId", a.subject_id AS "subjectId", a.revision,
       a.slot_no AS "slotNo"
FROM input
CROSS JOIN LATERAL (
  SELECT assignment.assignment_id, assignment.label_id, assignment.subject_id, assignment.revision,
         assignment.slot_no
  FROM library.label_assignment AS assignment
  WHERE assignment.route = input.route AND assignment.account_id = input.account_id
    AND assignment.subject_id = input.subject_id
    AND assignment.slot_no IS NOT NULL
  ORDER BY assignment.route, assignment.account_id, assignment.subject_id, assignment.assignment_id
  LIMIT 32
) AS a;
