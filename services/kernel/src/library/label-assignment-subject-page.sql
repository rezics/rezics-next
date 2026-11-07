-- Correlated reserved-source seeks retain the partial index under generic prepared plans.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :subject_id::uuid AS subject_id
)
SELECT a.assignment_id AS id, a.label_id AS "labelId", a.subject_id AS "subjectId", a.revision,
       a.slot_no AS "slotNo"
FROM input
CROSS JOIN LATERAL (
  SELECT assignment_id, label_id, subject_id, revision, slot_no
  FROM library.label_assignment
  WHERE route = input.route AND account_id = input.account_id AND subject_id = input.subject_id
    AND slot_no IS NOT NULL
  ORDER BY assignment_id LIMIT 32
) AS a;
