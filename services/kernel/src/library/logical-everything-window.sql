-- unbound: the admitted logical Source, its published generation and its bounded id-ordered raw suffix.
WITH published AS MATERIALIZED (
  SELECT g.route, g.collection_id, g.generation, s.account_id
  FROM library.logical_everything_source s
  JOIN library.canonical_source_head h USING (route, collection_id)
  JOIN library.canonical_source_generation g
    ON (g.route,g.collection_id,g.generation) = (h.route,h.collection_id,h.generation)
  JOIN library.canonical_source_scope capture
    ON (capture.route, capture.collection_id, capture.source_fence) = (g.route, g.collection_id, $6)
  WHERE (s.route, s.account_id, s.collection_id) = ($1, $2, $3)
    AND NOT EXISTS (SELECT 1 FROM library.builtin_collection_reference ref
      WHERE (ref.route,ref.collection_id)=(s.route,s.collection_id))
    AND s.generation = $4::bigint AND s.incarnation = $5
    AND capture.identity = $7::jsonb
    AND g.logical_owner_id = s.account_id AND g.state = 'complete' AND g.source_exhausted
    AND g.basis->>'digest' = $8 AND g.query_capture_id = $9::uuid
    AND g.query_capture_revision = $10::bigint
    AND (capture.capture_id, capture.committed_revision) = (g.query_capture_id, g.query_capture_revision)
), suffix AS MATERIALIZED (
  SELECT r.*
  FROM published p CROSS JOIN LATERAL (
    SELECT canonical_subject_id AS terminal, stored_subject_id AS original, driver, fact_id
    FROM library.canonical_source_reference r
    WHERE (r.route, r.collection_id, r.generation) = (p.route, p.collection_id, p.generation)
      AND r.canonical_subject_id > COALESCE($11::uuid, '00000000-0000-0000-0000-000000000000')
    ORDER BY canonical_subject_id, stored_subject_id, driver, fact_id LIMIT $12
  ) r
)
SELECT p.generation, r.terminal, r.original, r.driver, r.fact_id,
  CASE r.driver
    WHEN 1 THEN EXISTS (SELECT 1 FROM library.entry e WHERE
      (e.route,e.account_id,e.subject_id) = ($1,$2,r.original) AND e.subject_id=r.fact_id AND e.state IS NOT NULL)
      OR EXISTS (SELECT 1 FROM library.entry_personal_fact e WHERE
        (e.route,e.account_id,e.subject_id) = ($1,$2,r.original) AND e.fact_id=r.fact_id AND
        (e.note IS NOT NULL OR e.priority IS NOT NULL OR EXISTS (
          SELECT 1 FROM library.entry_source_observation o WHERE
          (o.route,o.account_id,o.subject_id) = (e.route,e.account_id,e.subject_id))))
    WHEN 2 THEN EXISTS (SELECT 1 FROM library.label_assignment a
      JOIN library.personal_label l USING (route,account_id,label_id)
      WHERE (a.route,a.account_id,a.subject_id,a.assignment_id) = ($1,$2,r.original,r.fact_id)
        AND a.slot_no IS NOT NULL AND a.deleted_at IS NULL AND l.deleted_at IS NULL)
    WHEN 3 THEN EXISTS (SELECT 1 FROM library.progress_session s WHERE
      (s.route,s.account_id,s.subject_id,s.session_id) = ($1,$2,r.original,r.fact_id) AND s.state <> 'retired')
    WHEN 4 THEN EXISTS (SELECT 1 FROM library.copy c WHERE
      (c.route,c.account_id,c.subject_id,c.copy_id) = ($1,$2,r.original,r.fact_id) AND c.deletion_id IS NULL)
  END AS present
FROM published p LEFT JOIN suffix r ON true
ORDER BY r.terminal, r.original, r.driver, r.fact_id;
