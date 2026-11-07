-- Correlated reserved-source seeks retain the partial index under generic prepared
-- plans. NOT MATERIALIZED plus LIMIT 32 Seq Scanned a small assignment table. ROW
-- bounds alone can still scan the relation in a custom plan with constant UUIDs, so
-- repeat the scalar owner and subject equalities. MATERIALIZED input, the bounded
-- reserved-source range, and OFFSET 0 keep label_assignment_reserved_source.
-- ORDER BY names that index. Slot filter stays so the partial index applies.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :subject_id::uuid AS subject_id,
         '00000000-0000-0000-0000-000000000000'::uuid AS first_assignment_id,
         'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid AS last_assignment_id
)
SELECT a.assignment_id AS id, a.label_id AS "labelId", a.subject_id AS "subjectId", a.revision,
       a.slot_no AS "slotNo"
FROM input
CROSS JOIN LATERAL (
  SELECT assignment.assignment_id, assignment.label_id, assignment.subject_id, assignment.revision,
         assignment.slot_no
  FROM library.label_assignment AS assignment
  WHERE ROW(assignment.route, assignment.account_id, assignment.subject_id, assignment.assignment_id)
          >= ROW(input.route, input.account_id, input.subject_id, input.first_assignment_id)
    AND ROW(assignment.route, assignment.account_id, assignment.subject_id, assignment.assignment_id)
          <= ROW(input.route, input.account_id, input.subject_id, input.last_assignment_id)
    AND assignment.route = input.route
    AND assignment.account_id = input.account_id
    AND assignment.subject_id = input.subject_id
    AND assignment.slot_no IS NOT NULL
  ORDER BY assignment.route, assignment.account_id, assignment.subject_id, assignment.assignment_id
  OFFSET 0
  LIMIT 32
) AS a;
