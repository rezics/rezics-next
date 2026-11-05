-- Each native subject/fact driver is independently bounded before the union/sort.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id, :limit::integer AS batch_limit
)
SELECT raw.driver, raw.fact_id::text AS "factId", raw.label_id::text AS "labelId"
FROM input i CROSS JOIN LATERAL (
  -- An unidentified live assignment is missing native fact coverage, never label absence under NOT.
  (SELECT 0 AS driver, a.label_id AS fact_id, a.label_id
   FROM library.label_assignment a
   WHERE a.route=i.route AND a.account_id=i.account_id AND a.subject_id=i.subject_id
     AND a.deleted_at IS NULL AND (a.slot_no IS NULL OR a.assignment_id IS NULL)
   ORDER BY a.label_id LIMIT 1)
  UNION ALL
  (SELECT 1 AS driver, e.subject_id AS fact_id, NULL::uuid AS label_id
   FROM library.entry e
   WHERE e.route=i.route AND e.account_id=i.account_id AND e.subject_id=i.subject_id
   LIMIT 1)
  UNION ALL
  (SELECT 2, a.assignment_id, a.label_id FROM library.label_assignment a
   WHERE a.route=i.route AND a.account_id=i.account_id AND a.subject_id=i.subject_id AND a.slot_no IS NOT NULL
   ORDER BY a.assignment_id LIMIT i.batch_limit)
  UNION ALL
  (SELECT 3, s.session_id, NULL::uuid FROM library.progress_session s
   WHERE s.state <> 'retired' AND s.route=i.route AND s.account_id=i.account_id AND s.subject_id=i.subject_id
   ORDER BY s.session_id LIMIT i.batch_limit)
  UNION ALL
  (SELECT 4, c.copy_id, NULL::uuid FROM library.copy c
   WHERE c.route=i.route AND c.account_id=i.account_id AND c.subject_id=i.subject_id AND c.deletion_id IS NULL
   ORDER BY c.copy_id LIMIT i.batch_limit)
) raw
ORDER BY raw.driver, raw.fact_id
LIMIT (SELECT batch_limit FROM input);
