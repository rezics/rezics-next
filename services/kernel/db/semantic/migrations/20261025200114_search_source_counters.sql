-- migrate:up
ALTER TABLE semantic.subject
  ADD COLUMN current_facts integer NOT NULL DEFAULT 0,
  ADD COLUMN current_release text;

ALTER TABLE semantic.fact
  ADD COLUMN release text;

UPDATE semantic.fact f
SET release = r.release
FROM semantic.revision r
WHERE f.kind = 'statement'
  AND f.operation = 'assert'
  AND r.route = f.route
  AND r.subject_id = f.subject_id
  AND r.recorded_transaction_id = f.recorded_transaction_id;

ALTER TABLE semantic.fact
  ADD CONSTRAINT fact_release_check CHECK (
    (kind = 'statement' AND operation = 'assert') = (release IS NOT NULL)
  );

WITH latest_release AS (
  SELECT DISTINCT ON (route, subject_id) route, subject_id, release
  FROM semantic.revision
  ORDER BY route, subject_id, revision DESC
)
UPDATE semantic.subject s
SET current_release = latest_release.release
FROM latest_release
WHERE latest_release.route = s.route AND latest_release.subject_id = s.subject_id;

ALTER TABLE semantic.subject ALTER COLUMN current_release SET NOT NULL;

WITH statement_slots AS (
  SELECT DISTINCT ON (route, subject_id, slot_id)
         route, subject_id, slot_id, operation
  FROM semantic.fact
  WHERE kind = 'statement'
  ORDER BY route, subject_id, slot_id, log_seq DESC
), compact_latest AS (
  SELECT DISTINCT ON (f.route, f.subject_id, f.slot_id, f.statement_id)
         f.route, f.subject_id, f.slot_id, f.statement_id, f.operation, f.body
  FROM semantic.fact f
  JOIN statement_slots s
    ON s.route = f.route AND s.subject_id = f.subject_id AND s.slot_id = f.slot_id
  WHERE f.kind = 'statement' AND s.operation <> 'expand'
  ORDER BY f.route, f.subject_id, f.slot_id, f.statement_id, f.log_seq DESC
), term_latest AS (
  SELECT DISTINCT ON (route, subject_id, slot_id)
         route, subject_id, slot_id, operation
  FROM semantic.fact
  WHERE kind IN ('label', 'description')
  ORDER BY route, subject_id, slot_id, log_seq DESC
), alias_latest AS (
  SELECT DISTINCT ON (route, subject_id, slot_id, body)
         route, subject_id, slot_id, body, operation
  FROM semantic.fact
  WHERE kind = 'alias'
  ORDER BY route, subject_id, slot_id, body, log_seq DESC
), term_counts AS (
  SELECT route, subject_id, count(*)::integer AS count
  FROM (
    SELECT route, subject_id FROM term_latest WHERE operation = 'assert'
    UNION ALL
    SELECT route, subject_id FROM alias_latest WHERE operation = 'assert'
  ) current_terms
  GROUP BY route, subject_id
), compact_counts AS (
  SELECT route, subject_id, count(*)::integer AS count
  FROM compact_latest
  WHERE operation = 'assert' AND body->>'rank' IN ('normal', 'preferred')
  GROUP BY route, subject_id
), global_adoptions AS (
  SELECT DISTINCT ON (a.route, a.subject_id, a.slot_id)
         a.route, a.subject_id, a.slot_id, a.mode, a.selection
  FROM semantic.adoption a
  WHERE a.context_id = '00000000-0000-8000-8000-000000000000'
  ORDER BY a.route, a.subject_id, a.slot_id, a.head DESC
), expanded_counts AS (
  SELECT s.route, s.subject_id,
         sum(CASE WHEN a.mode = 'replace' THEN jsonb_array_length(a.selection) ELSE 0 END)::integer AS count
  FROM statement_slots s
  LEFT JOIN global_adoptions a
    ON a.route = s.route AND a.subject_id = s.subject_id AND a.slot_id = s.slot_id
  WHERE s.operation = 'expand'
  GROUP BY s.route, s.subject_id
), current_counts AS (
  SELECT s.route, s.subject_id,
         COALESCE(t.count, 0) + COALESCE(c.count, 0) + COALESCE(e.count, 0) AS count
  FROM semantic.subject s
  LEFT JOIN term_counts t ON t.route = s.route AND t.subject_id = s.subject_id
  LEFT JOIN compact_counts c ON c.route = s.route AND c.subject_id = s.subject_id
  LEFT JOIN expanded_counts e ON e.route = s.route AND e.subject_id = s.subject_id
)
UPDATE semantic.subject s
SET current_facts = current_counts.count
FROM current_counts
WHERE current_counts.route = s.route AND current_counts.subject_id = s.subject_id;

CREATE TABLE semantic.partition_subjects (
  partition_no integer NOT NULL PRIMARY KEY,
  visible bigint NOT NULL DEFAULT 0,
  CONSTRAINT partition_subjects_partition_check CHECK (partition_no BETWEEN 0 AND 4095),
  CONSTRAINT partition_subjects_visible_check CHECK (visible >= 0)
);

INSERT INTO semantic.partition_subjects (partition_no, visible)
SELECT p.partition_no,
       count(s.subject_id) FILTER (
         WHERE s.visibility = 'visible'
           AND NOT EXISTS (
             SELECT 1 FROM semantic.redirect r
             WHERE r.route = s.route AND r.subject_id = s.subject_id
           )
       )::bigint
FROM core.partition p
LEFT JOIN semantic.subject s
  ON s.route >= p.partition_no * 16 AND s.route < (p.partition_no + 1) * 16
GROUP BY p.partition_no;

-- migrate:down
DROP TABLE semantic.partition_subjects;
ALTER TABLE semantic.fact DROP COLUMN release;
ALTER TABLE semantic.subject DROP COLUMN current_release, DROP COLUMN current_facts;
