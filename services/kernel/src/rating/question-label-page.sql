WITH input AS (
  SELECT :question_id::uuid AS question_id, :after::integer AS after_revision,
         :ceiling::integer AS ceiling, :limit::integer AS page_limit
)
SELECT * FROM (
  SELECT q.id AS "questionId", 1 AS "labelRevision", q.label, q.owner_id AS "authorId", NULL::text AS at
  FROM rating.question q
  WHERE q.id = (SELECT question_id FROM input) AND q.realm_id IS NOT NULL AND (SELECT after_revision FROM input) < 1
  UNION ALL
  (SELECT r.question_id AS "questionId", r.revision AS "labelRevision", r.label,
          r.author_id AS "authorId", r.changed_at::text AS at
   FROM rating.question_label_revision r
   WHERE r.question_id = (SELECT question_id FROM input) AND r.revision > (SELECT after_revision FROM input) AND r.revision <= (SELECT ceiling FROM input)
   ORDER BY r.revision LIMIT ((SELECT page_limit FROM input) + 1))
) labels
ORDER BY "labelRevision"
LIMIT ((SELECT page_limit FROM input) + 1);
