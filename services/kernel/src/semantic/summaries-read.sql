-- Only the two named slots are probed; a work's editions are never enumerated.
WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT s.subject_id::text AS id, s.type,
       COALESCE(labels.body, '{}'::jsonb) AS labels,
       COALESCE(choices.body, '[]'::jsonb) AS choices
FROM jsonb_to_recordset(:subjects::jsonb) AS requested(route integer, id uuid, image uuid)
CROSS JOIN input
JOIN LATERAL (
  SELECT subject_id, type FROM semantic.subject
  WHERE route = requested.route AND subject_id = requested.id AND visibility = 'visible'
    AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
  LIMIT 1
) AS s ON true
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(language, body) AS body FROM (
    SELECT DISTINCT ON (language) language, body, operation
    FROM semantic.fact
    WHERE route = requested.route AND subject_id = requested.id AND kind = 'label'
      AND route >= input.partition_no * 16 AND route < (input.partition_no + 1) * 16
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
        AND context_id = :context_id::uuid AND head.operation = 'expand'
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
    )
) AS choices ON true;
