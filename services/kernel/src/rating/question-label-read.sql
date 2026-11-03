SELECT q.id AS "questionId", 1 AS "labelRevision", q.label, q.owner_id AS "authorId", NULL::text AS at
FROM rating.question q
WHERE q.id = :question_id::uuid AND q.realm_id IS NOT NULL AND :revision::integer = 1
UNION ALL
SELECT r.question_id AS "questionId", r.revision AS "labelRevision", r.label,
       r.author_id AS "authorId", r.changed_at::text AS at
FROM rating.question_label_revision r
WHERE r.question_id = :question_id::uuid AND r.revision = :revision::integer;
