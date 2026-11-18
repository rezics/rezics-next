-- migrate:up
ALTER TABLE library.canonical_source_generation
  ADD COLUMN query_capture_id uuid,
  ADD COLUMN query_capture_revision bigint,
  ADD CHECK ((query_capture_id IS NULL AND query_capture_revision IS NULL) OR
    (logical_owner_id IS NOT NULL AND query_capture_id IS NOT NULL AND query_capture_revision IS NOT NULL
     AND query_capture_revision>0 AND state='complete' AND source_exhausted));

-- Seek registered personal inputs without walking empty annotation shells or a subject's provider history.
CREATE INDEX entry_personal_live_annotation_subject ON library.entry_personal_fact(route,account_id,subject_id)
WHERE note IS NOT NULL OR priority IS NOT NULL;

CREATE FUNCTION library.personal_source_page(r integer, a uuid, lower_subject uuid, page_size integer)
RETURNS TABLE(subject_id uuid,fact_id uuid,transaction_id uuid) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE observed(id,n) AS (
    (SELECT o.subject_id,1 FROM library.entry_source_observation o
     WHERE o.route=r AND o.account_id=a AND o.subject_id>=lower_subject ORDER BY o.subject_id LIMIT 1)
    UNION ALL
    SELECT successor.subject_id,prior.n+1 FROM observed prior CROSS JOIN LATERAL (
      SELECT o.subject_id FROM library.entry_source_observation o
      WHERE o.route=r AND o.account_id=a AND o.subject_id>prior.id ORDER BY o.subject_id LIMIT 1
    ) successor WHERE prior.n<LEAST(page_size,101)
  ), subjects AS MATERIALIZED (
    (SELECT p.subject_id FROM library.entry_personal_fact p WHERE p.route=r AND p.account_id=a
      AND p.subject_id>=lower_subject AND (p.note IS NOT NULL OR p.priority IS NOT NULL)
      ORDER BY p.subject_id LIMIT LEAST(page_size,101))
    UNION SELECT id FROM observed ORDER BY 1 LIMIT LEAST(page_size,101)
  )
  SELECT p.subject_id,p.fact_id,p.transaction_id FROM subjects s JOIN library.entry_personal_fact p
    ON p.route=r AND p.account_id=a AND p.subject_id=s.subject_id
$$;

-- migrate:down
-- Forward only after logical Source capture has retained owner custody.
