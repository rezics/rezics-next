-- Gates are inside each independently limited indexed branch; no other fact driver is read.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         COALESCE(:after_subject::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid) AS after_subject,
         COALESCE(:after_fact::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid) AS after_fact,
         :limit::integer AS batch_limit, :driver::text AS driver
)
SELECT raw.subject_id::text AS "storedSubjectId", raw.fact_id::text AS "factId"
FROM input i CROSS JOIN LATERAL (
  (SELECT facts.subject_id, facts.fact_id FROM (
     (SELECT e.subject_id, e.subject_id AS fact_id FROM library.entry e
      WHERE i.driver = 'entry' AND e.route = i.route AND e.account_id = i.account_id
        AND (e.subject_id,e.subject_id) > (i.after_subject,i.after_fact)
      ORDER BY e.subject_id,e.subject_id LIMIT i.batch_limit)
     UNION ALL
     (SELECT p.subject_id, p.fact_id FROM library.entry_personal_fact p
      WHERE i.driver = 'entry' AND p.route = i.route AND p.account_id = i.account_id
        AND (p.note IS NOT NULL OR p.priority IS NOT NULL OR EXISTS(
          SELECT 1 FROM library.entry_source_observation o WHERE o.route=p.route AND o.account_id=p.account_id
            AND o.subject_id=p.subject_id))
        AND (p.subject_id,p.fact_id) > (i.after_subject,i.after_fact)
      ORDER BY p.subject_id,p.fact_id LIMIT i.batch_limit)
   ) facts
   ORDER BY facts.subject_id,facts.fact_id LIMIT i.batch_limit)
  UNION ALL
  (SELECT c.subject_id, c.copy_id FROM library.copy c
   WHERE i.driver = 'copy' AND c.deletion_id IS NULL AND c.route = i.route AND c.account_id = i.account_id
     AND (c.subject_id, c.copy_id) > (i.after_subject, i.after_fact)
   ORDER BY c.subject_id, c.copy_id LIMIT i.batch_limit)
  UNION ALL
  (SELECT s.subject_id, s.session_id FROM library.progress_session s
   WHERE s.state <> 'retired' AND i.driver = 'session' AND s.route = i.route AND s.account_id = i.account_id
     AND (s.subject_id, s.session_id) > (i.after_subject, i.after_fact)
   ORDER BY s.subject_id, s.session_id LIMIT i.batch_limit)
  UNION ALL
  (SELECT a.subject_id, a.assignment_id FROM library.label_assignment a
   WHERE i.driver = 'label' AND a.route = i.route AND a.account_id = i.account_id AND a.slot_no IS NOT NULL
     AND (a.subject_id, a.assignment_id) > (i.after_subject, i.after_fact)
   ORDER BY a.subject_id, a.assignment_id LIMIT i.batch_limit)
) AS raw
ORDER BY raw.subject_id, raw.fact_id;
