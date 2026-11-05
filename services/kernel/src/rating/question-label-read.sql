WITH input AS (SELECT :question_id::uuid AS question_id, :revision::integer AS revision)
SELECT q.id AS "questionId", 1 AS "labelRevision", q.label, q.owner_id AS "authorId", NULL::text AS at
FROM rating.question q
WHERE q.id = (SELECT question_id FROM input) AND q.realm_id IS NOT NULL AND (SELECT revision FROM input) = 1
UNION ALL
SELECT r.question_id AS "questionId", r.revision AS "labelRevision", r.label,
       r.author_id AS "authorId", r.changed_at::text AS at
FROM rating.question_label_revision r
WHERE r.question_id = (SELECT question_id FROM input) AND r.revision = (SELECT revision FROM input);
