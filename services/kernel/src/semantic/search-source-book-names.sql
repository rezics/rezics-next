-- One routed point per candidate. Probe only the current label heads and the
-- selected original-language property needed by Book's catalogue rendering.
SELECT wanted.route, wanted.id::text AS id, home.position::text AS position,
       home.write_state AS "writeState", home.moved_to AS "movedTo",
       subject.type, subject.visibility, subject.security_revision::text AS "securityRevision",
       redirect.target::text AS redirect, COALESCE(state.ready, false) AS ready,
       labels.body AS labels, languages.body AS languages,
       COALESCE(labels.wide, false) OR COALESCE(languages.wide, false) AS wide
FROM unnest(:routes::integer[], :subject_ids::uuid[]) WITH ORDINALITY AS wanted(route, id, ordinal)
LEFT JOIN LATERAL (
  SELECT position, write_state, moved_to FROM core.partition
  WHERE partition_no = wanted.route / 16 LIMIT 1
) home ON true
LEFT JOIN LATERAL (
  SELECT route, subject_id, type, visibility, security_revision FROM semantic.subject
  WHERE route = wanted.route AND subject_id = wanted.id AND home.write_state <> 'moved' LIMIT 1
) subject ON true
LEFT JOIN LATERAL (
  SELECT ready FROM semantic.search_selection_state
  WHERE route = subject.route AND subject_id = subject.subject_id LIMIT 1
) state ON true
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect
  WHERE route = subject.route AND subject_id = subject.subject_id
  ORDER BY sequence DESC LIMIT 1
) redirect ON true
LEFT JOIN LATERAL (
  -- Follow the current term view's active pointer and assert floor. A label
  -- head supplies one current value, ordered by the latest assert on its slot.
  WITH heads AS MATERIALIZED (
    SELECT h.route, h.subject_id, h.language, h.slot_id, h.first_seq
    FROM semantic.term_head h
    WHERE h.route = subject.route AND h.subject_id = subject.subject_id AND h.kind = 'label' AND h.active
      AND state.ready AND subject.visibility = 'visible' AND redirect.target IS NULL
    ORDER BY h.language
    LIMIT :label_limit::integer
  )
  SELECT (SELECT count(*) FROM heads) >= :label_limit::integer AS wide,
         jsonb_agg(jsonb_build_object('language', label.language, 'value', label.value)
                   ORDER BY label.language COLLATE "C") AS body
  FROM heads h
  CROSS JOIN LATERAL (
    SELECT f.language, f.body #>> '{}' AS value FROM semantic.fact f
    WHERE f.route = h.route AND f.subject_id = h.subject_id AND f.slot_id = h.slot_id AND f.log_seq >= h.first_seq
      AND f.kind = 'label' AND f.language = h.language AND f.operation = 'assert' AND jsonb_typeof(f.body) = 'string'
    ORDER BY f.log_seq DESC LIMIT 1
  ) label
) labels ON true
LEFT JOIN LATERAL (
  WITH selected AS MATERIALIZED (
    SELECT s.route, s.subject_id, s.slot_id, s.candidate_id, s.ordinal, s.release, s.body->'value' AS value
    FROM semantic.search_selected s
    WHERE s.route = subject.route AND s.subject_id = subject.subject_id
      AND s.property = 'schema:inLanguage' AND s.active AND s.relation IS FALSE
      AND state.ready AND subject.visibility = 'visible' AND redirect.target IS NULL
    ORDER BY s.slot_id, s.candidate_id
    LIMIT :language_limit::integer
  )
  -- The same concealment floor as search-source-statements.sql, on exact
  -- selected candidate keys. Imported-source fences are checked on this snapshot.
  SELECT (SELECT count(*) FROM selected) >= :language_limit::integer AS wide,
         jsonb_agg(jsonb_build_object(
           'route', s.route, 'subject_id', s.subject_id, 'slot_id', s.slot_id,
           'candidate_id', s.candidate_id, 'release', s.release, 'value', s.value
         ) ORDER BY s.ordinal, s.slot_id, s.candidate_id) AS body
  FROM selected s
  WHERE NOT EXISTS (
    SELECT 1 FROM semantic.hidden_candidate h
    WHERE h.route = s.route AND h.subject_id = s.subject_id AND h.candidate_id = s.candidate_id
    UNION ALL
    SELECT 1 FROM semantic.record_lifecycle l
    WHERE l.route = s.route AND l.subject_id = s.subject_id AND l.candidate_id = s.candidate_id
      AND l.state IN ('deleted', 'purging', 'purged')
    UNION ALL
    SELECT 1 FROM semantic.statement_disclosure d
    WHERE d.route = s.route AND d.subject_id = s.subject_id AND d.candidate_id = s.candidate_id
      AND (NOT d.disclosed OR EXISTS (
        SELECT 1 FROM semantic.retraction t
        WHERE t.route = d.route AND t.subject_id = d.subject_id AND t.candidate_id = d.candidate_id
      ))
  )
) languages ON true
ORDER BY wanted.ordinal;
