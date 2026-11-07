-- Unique PK as a parameterized nested-loop inner so generic prepared plans use
-- label_assignment_pkey. NOT MATERIALIZED inlined the one-row CTE; LATERAL LIMIT 1
-- Seq Scanned because LIMIT 1 lets Seq Scan stop early. Equality filters still
-- Seq Scan when a custom plan inlines the UUID. MATERIALIZED input, Access
-- ROW-bounded primary-key range, exact key equalities, and OFFSET 0 keep
-- label_assignment_pkey when generic plans cannot reduce the ROW bound.
-- ORDER BY names the primary key with no LIMIT.
WITH input AS MATERIALIZED (
  SELECT :time::nullable(timestamptz) AS time, :route::integer AS route,
         :account_id::uuid AS account_id, :subject_id::uuid AS subject_id, :label_id::uuid AS label_id
)
SELECT a.route, a.account_id AS "accountId", a.subject_id AS "subjectId", a.label_id AS "labelId",
       a.assignment_id AS id, a.revision, a.slot_no AS "slotNo",
       a.created_at::text AS "createdAt", a.updated_at::text AS "updatedAt",
       a.deleted_at::text AS "deletedAt", a.purge_after::text AS "purgeAfter",
       a.transaction_id AS "transactionId",
       a.assignment_id = :assignment_id::nullable(uuid) AS "identityMatches",
       a.deleted_at <= input.time AS started,
       input.time >= a.purge_after AS expired
FROM input CROSS JOIN LATERAL (
  SELECT *
  FROM library.label_assignment AS a
  WHERE ROW(a.route, a.account_id, a.subject_id, a.label_id)
          >= ROW(input.route, input.account_id, input.subject_id, input.label_id)
    AND ROW(a.route, a.account_id, a.subject_id, a.label_id)
          <= ROW(input.route, input.account_id, input.subject_id, input.label_id)
    AND a.route = input.route
    AND a.account_id = input.account_id
    AND a.subject_id = input.subject_id
    AND a.label_id = input.label_id
  ORDER BY a.route, a.account_id, a.subject_id, a.label_id
  OFFSET 0
) AS a;
