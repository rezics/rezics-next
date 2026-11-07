-- The retained row is located by route/account/assignment identity; tuple checks
-- reject an identity that was moved or replaced while preserving the exact owner.
-- Keep the primary-key range and scalar equalities so generic plans seek the
-- unique label_assignment_identity index before checking the subject and label.
WITH input AS MATERIALIZED (
  SELECT :time::nullable(timestamptz) AS time, :route::integer AS route,
         :account_id::uuid AS account_id, :subject_id::uuid AS subject_id,
         :label_id::uuid AS label_id, :assignment_id::uuid AS assignment_id
)
SELECT a.route, a.account_id AS "accountId", a.subject_id AS "subjectId", a.label_id AS "labelId",
       a.assignment_id AS id, a.revision, a.slot_no AS "slotNo",
       a.created_at::text AS "createdAt", a.updated_at::text AS "updatedAt",
       a.deleted_at::text AS "deletedAt", a.purge_after::text AS "purgeAfter",
       a.transaction_id AS "transactionId",
       a.assignment_id = input.assignment_id AS "identityMatches",
       a.deleted_at <= input.time AS started,
       input.time >= a.purge_after AS expired
FROM input CROSS JOIN LATERAL (
  SELECT assignment.*
  FROM library.label_assignment AS assignment
  WHERE ROW(assignment.route, assignment.account_id, assignment.assignment_id)
          >= ROW(input.route, input.account_id, input.assignment_id)
    AND ROW(assignment.route, assignment.account_id, assignment.assignment_id)
          <= ROW(input.route, input.account_id, input.assignment_id)
    AND assignment.route = input.route
    AND assignment.account_id = input.account_id
    AND assignment.assignment_id = input.assignment_id
    AND assignment.subject_id = input.subject_id
    AND assignment.label_id = input.label_id
  ORDER BY assignment.route, assignment.account_id, assignment.assignment_id
  OFFSET 0
) AS a;
