-- Only the requested image, representative-edition and original-language slots are probed; editions are never enumerated.
WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :context_id::uuid AS context_id
)
SELECT s.subject_id::text AS id, s.type,
       COALESCE(labels.body, '{}'::jsonb) AS labels, original.language AS original,
       COALESCE(choices.body, '[]'::jsonb) AS choices
FROM jsonb_to_recordset(:subjects::jsonb) AS requested(route integer, id uuid, image uuid, original uuid)
CROSS JOIN input
JOIN LATERAL (
  SELECT subject_id, type FROM semantic.subject
  WHERE route = requested.route AND subject_id = requested.id AND visibility = 'visible'
    AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
  LIMIT 1
) AS s ON true
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
) AS original ON true
LEFT JOIN LATERAL (
  -- The active term-head index supplies the ordinary alphabetical fallback
  -- without reading every language. A label head contains one current value.
  SELECT language FROM semantic.term_head
  WHERE :display_fallback::boolean AND active AND kind = 'label'
    AND route = requested.route AND subject_id = requested.id
    AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
  ORDER BY language LIMIT 1
) AS fallback ON true
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(language, body) AS body FROM (
    SELECT DISTINCT ON (language) language, body, operation
    FROM semantic.current_term_fact
    WHERE route = requested.route AND subject_id = requested.id AND kind = 'label'
      AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
      AND (NOT :bounded_labels::boolean OR language = ANY(:label_languages::text[])
           OR language = original.language OR language = fallback.language)
    ORDER BY language, log_seq DESC
  ) AS latest WHERE operation = 'assert'
) AS labels ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('property', slots.property, 'statement', live.body)
                   ORDER BY slots.property, live.ordinal, live.id) AS body
  FROM (
    SELECT 'schema:image'::text AS property, requested.image AS slot, 0 AS ordinal
    UNION ALL
    SELECT 'rezics:representativeEdition', representatives.slot_id, representatives.ordinal
    FROM jsonb_to_recordset(:representatives::jsonb) AS representatives(id uuid, slot_id uuid, ordinal integer)
    WHERE representatives.id = requested.id
  ) AS slots(property, slot, ordinal)
  CROSS JOIN LATERAL (
    SELECT operation FROM semantic.fact
    WHERE route = requested.route AND subject_id = requested.id AND slot_id = slots.slot
      AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
    ORDER BY log_seq DESC LIMIT 1
  ) AS head
  CROSS JOIN LATERAL (
    SELECT compact.statement_id AS id, compact.body, compact.log_seq AS ordinal
    FROM (
      SELECT DISTINCT ON (statement_id) statement_id, body, log_seq, operation
      FROM semantic.fact
      WHERE route = requested.route AND subject_id = requested.id AND slot_id = slots.slot
        AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
        AND head.operation <> 'expand'
      ORDER BY statement_id, log_seq DESC
    ) AS compact
    WHERE compact.operation = 'assert'
    UNION ALL
    SELECT c.candidate_id, c.statement || jsonb_build_object('rank', selected.entry->>'rank'),
           selected.ordinal::integer
    FROM LATERAL (
      SELECT mode, selection FROM semantic.adoption
      WHERE route = requested.route AND subject_id = requested.id AND slot_id = slots.slot
        AND context_id = input.context_id AND head.operation = 'expand'
        AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
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
  ) AS live
  WHERE COALESCE(live.body->>'rank', 'normal') <> 'deprecated'
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
  ) AS choices ON true;
