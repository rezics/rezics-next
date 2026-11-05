WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id, :label_id::uuid AS label_id
), reserved AS MATERIALIZED (
  SELECT a.assignment_id AS id, a.label_id AS "labelId", a.subject_id AS "subjectId", a.revision,
         a.slot_no AS "slotNo", NULL::text AS "createdAt", NULL::text AS "updatedAt",
         NULL::text AS "deletedAt", NULL::text AS "purgeAfter", false AS desired
  FROM input CROSS JOIN LATERAL (
    SELECT a.assignment_id, a.label_id, a.subject_id, a.revision, a.slot_no
    FROM library.label_assignment AS a
    WHERE a.route = input.route AND a.account_id = input.account_id AND a.subject_id = input.subject_id
      AND a.slot_no IS NOT NULL
    ORDER BY a.assignment_id
    LIMIT 32
  ) AS a
)
-- Parameterize the bounded source by its subject, as for the native parent points.
SELECT * FROM reserved
UNION ALL
SELECT a.assignment_id AS id, a.label_id AS "labelId", a.subject_id AS "subjectId", a.revision,
       a.slot_no AS "slotNo", a.created_at::text AS "createdAt", a.updated_at::text AS "updatedAt",
       a.deleted_at::text AS "deletedAt", a.purge_after::text AS "purgeAfter", true AS desired
FROM library.label_assignment AS a CROSS JOIN input
WHERE a.route = input.route AND a.account_id = input.account_id AND a.subject_id = input.subject_id
  AND a.label_id = input.label_id;
