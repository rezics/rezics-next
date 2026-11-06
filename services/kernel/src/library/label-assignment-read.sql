WITH input AS NOT MATERIALIZED (
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
  WHERE a.route = input.route AND a.account_id = input.account_id
    AND a.subject_id = input.subject_id AND a.label_id = input.label_id
  LIMIT 1
) AS a;
