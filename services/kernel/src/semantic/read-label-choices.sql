WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :context_id::uuid AS context_id
)
SELECT s.subject_id::text AS id,
       COALESCE(labels.body, '{}'::jsonb) AS labels, original.language AS original
FROM jsonb_to_recordset(:subjects::jsonb) AS requested(route integer, id uuid, original uuid)
CROSS JOIN input
JOIN LATERAL (
  SELECT subject_id FROM semantic.subject
  CROSS JOIN input
  WHERE route = requested.route AND subject_id = requested.id AND visibility = 'visible'
    AND route >= input.partition_no * 16
    AND route < (input.partition_no + 1) * 16
  LIMIT 1
) AS s ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(jsonb_object_agg(language, body), '{}'::jsonb) AS body
  FROM (
    SELECT DISTINCT ON (language) language, body
    FROM (
      SELECT language, body, log_seq FROM semantic.current_term_fact
      CROSS JOIN input
      WHERE route = requested.route AND subject_id = requested.id
        AND kind = 'label' AND operation = 'assert'
        AND route >= input.partition_no * 16
        AND route < (input.partition_no + 1) * 16
      OFFSET 0
    ) scanned
    ORDER BY language, log_seq DESC
  ) label_rows
) AS labels ON true
LEFT JOIN LATERAL (
  -- One fact_pkey range for the original-language slot, including its expansion marker.
  WITH language_slot AS MATERIALIZED (
    SELECT statement_id, body, operation, log_seq FROM semantic.fact
    WHERE route = requested.route AND subject_id = requested.id AND slot_id = requested.original
      AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
  ), live AS (
    SELECT statement_id AS id, body, log_seq::bigint AS ordinal FROM (
      SELECT DISTINCT ON (statement_id) statement_id, body, operation, log_seq
      FROM language_slot
      WHERE NOT EXISTS (SELECT 1 FROM language_slot WHERE operation = 'expand')
      ORDER BY statement_id, log_seq DESC
    ) AS compact WHERE operation = 'assert'
    UNION ALL
    SELECT c.candidate_id, c.statement || jsonb_build_object('rank', selected.entry->>'rank'), selected.ordinal
    FROM LATERAL (
      SELECT mode, selection FROM semantic.adoption
      WHERE route = requested.route AND subject_id = requested.id AND slot_id = requested.original
        AND context_id = input.context_id
        AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
        AND EXISTS (SELECT 1 FROM language_slot WHERE operation = 'expand')
      ORDER BY head DESC LIMIT 1
    ) AS adoption
    CROSS JOIN LATERAL jsonb_array_elements(adoption.selection) WITH ORDINALITY AS selected(entry, ordinal)
    JOIN LATERAL (
      SELECT candidate_id, statement FROM semantic.candidate
      WHERE route = requested.route AND subject_id = requested.id
        AND candidate_id = (selected.entry->>'candidate')::uuid
        AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
      LIMIT 1
    ) AS c ON true
    WHERE adoption.mode = 'replace'
  )
  SELECT body->'value'->>'content' AS language FROM live
  WHERE COALESCE(body->>'rank', 'normal') <> 'deprecated'
    AND body->'value'->>'type' = 'value' AND jsonb_typeof(body->'value'->'content') = 'string'
    AND NOT EXISTS (
      SELECT 1 FROM semantic.hidden_candidate
      WHERE route = requested.route AND subject_id = requested.id AND candidate_id = live.id
        AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
      UNION ALL
      SELECT 1 FROM semantic.record_lifecycle
      WHERE route=requested.route AND subject_id=requested.id AND candidate_id=live.id
        AND state IN ('deleted','purging','purged')
        AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
      UNION ALL
      SELECT 1 FROM semantic.statement_disclosure d
      WHERE route = requested.route AND subject_id = requested.id AND candidate_id = live.id AND (NOT d.disclosed OR EXISTS (SELECT 1 FROM semantic.retraction t
        WHERE t.route = d.route AND t.route >= input.partition_no * 16 AND t.route < (input.partition_no + 1) * 16 AND t.subject_id = d.subject_id AND t.candidate_id = d.candidate_id))
        AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
    )
  ORDER BY (body->>'rank' = 'preferred') DESC NULLS LAST, ordinal, id
  LIMIT 1
) AS original ON true;
