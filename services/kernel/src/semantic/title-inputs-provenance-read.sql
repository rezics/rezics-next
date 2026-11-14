WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :context_id::uuid AS context_id
), requested AS NOT MATERIALIZED (
  SELECT route, id, language_slot, labels, original
  FROM jsonb_to_recordset(:subjects::jsonb) AS item(
    route integer, id uuid, language_slot uuid, labels jsonb, original text
  )
)
SELECT s.subject_id::text AS id,
       labels.bindings AS "labelBindings",
       labels.bindings_complete AS "labelBindingsComplete",
       original.language AS original,
       original.candidate::text AS "originalCandidate",
       original.support_revision AS "originalSupportRevision",
       original.source AS "originalSource",
       redirect.target::text AS redirect,
       latest.revision::text AS revision
FROM requested
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
  SELECT CASE WHEN octet_length(bindings::text) <= 16384
              THEN bindings ELSE '{}'::jsonb END AS bindings,
         octet_length(bindings::text) <= 16384 AS bindings_complete
  FROM (
    SELECT COALESCE(jsonb_object_agg(language, jsonb_build_object(
      'value', body,
      'revision', revision::text,
      'slot', slot_id::text,
      'sequence', log_seq,
      'source', source
    )), '{}'::jsonb) AS bindings
    FROM (
      SELECT wanted.language, selected.body, selected.slot_id, selected.log_seq,
             support.revision, support.source
      FROM jsonb_each_text(COALESCE(requested.labels, '{}'::jsonb)) AS wanted(language, value)
      LEFT JOIN LATERAL (
        SELECT body, slot_id, log_seq, recorded_transaction_id
        FROM (
          SELECT body, slot_id, log_seq, recorded_transaction_id
          FROM semantic.current_term_fact
          WHERE route = requested.route AND subject_id = requested.id
            AND kind = 'label' AND operation = 'assert' AND language = wanted.language
            AND route >= input.partition_no * 16
            AND route < (input.partition_no + 1) * 16
          OFFSET 0
        ) AS current_terms
        ORDER BY log_seq DESC
        LIMIT 1
      ) AS selected ON true
      LEFT JOIN LATERAL (
        SELECT revision, source FROM semantic.revision
        WHERE route = requested.route AND subject_id = requested.id
          AND recorded_transaction_id = selected.recorded_transaction_id
          AND route >= input.partition_no * 16
          AND route < (input.partition_no + 1) * 16
        LIMIT 1
      ) AS support ON true
    ) fields
  ) aggregated
) AS labels ON true
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect
  WHERE route = requested.route AND subject_id = requested.id
    AND route >= input.partition_no * 16
    AND route < (input.partition_no + 1) * 16
  ORDER BY sequence DESC
  LIMIT 1
) AS redirect ON true
LEFT JOIN LATERAL (
  SELECT revision FROM semantic.revision
  WHERE route = requested.route AND subject_id = requested.id
    AND route >= input.partition_no * 16
    AND route < (input.partition_no + 1) * 16
  ORDER BY revision DESC
  LIMIT 1
) AS latest ON true
LEFT JOIN LATERAL (
  WITH language_slot AS MATERIALIZED (
    SELECT statement_id, body, operation, log_seq, recorded_transaction_id
    FROM semantic.fact
    WHERE route = requested.route AND subject_id = requested.id AND slot_id = requested.language_slot
      AND route >= input.partition_no * 16
      AND route < (input.partition_no + 1) * 16
  ), live AS (
    SELECT compact.statement_id AS id, compact.body, compact.log_seq::bigint AS ordinal,
           compact.recorded_transaction_id AS support_transaction_id, NULL::integer AS candidate_revision
    FROM (
      SELECT DISTINCT ON (statement_id) statement_id, body, operation, log_seq, recorded_transaction_id
      FROM language_slot
      WHERE NOT EXISTS (SELECT 1 FROM language_slot WHERE operation = 'expand')
      ORDER BY statement_id, log_seq DESC
    ) AS compact
    WHERE compact.operation = 'assert'
    UNION ALL
    SELECT c.candidate_id, c.statement || jsonb_build_object('rank', selected.entry->>'rank'),
           selected.ordinal, NULL::uuid, c.revision
    FROM LATERAL (
      SELECT mode, selection FROM semantic.adoption
      WHERE route = requested.route AND subject_id = requested.id AND slot_id = requested.language_slot
        AND context_id = input.context_id
        AND route >= input.partition_no * 16
        AND route < (input.partition_no + 1) * 16
        AND EXISTS (SELECT 1 FROM language_slot WHERE operation = 'expand')
      ORDER BY head DESC
      LIMIT 1
    ) AS adoption
    CROSS JOIN LATERAL jsonb_array_elements(adoption.selection) WITH ORDINALITY AS selected(entry, ordinal)
    JOIN LATERAL (
      SELECT candidate_id, statement, revision FROM semantic.candidate
      WHERE route = requested.route AND subject_id = requested.id
        AND candidate_id = (selected.entry->>'candidate')::uuid
        AND route >= input.partition_no * 16
        AND route < (input.partition_no + 1) * 16
      LIMIT 1
    ) AS c ON true
    WHERE adoption.mode = 'replace'
  )
  SELECT picked.body->'value'->>'content' AS language, picked.id AS candidate,
         support.revision::text AS support_revision, support.source
  FROM (
    SELECT id, body, ordinal, support_transaction_id, candidate_revision
    FROM live
    WHERE COALESCE(body->>'rank', 'normal') <> 'deprecated'
      AND body->'value'->>'type' = 'value'
      AND jsonb_typeof(body->'value'->'content') = 'string'
      AND NOT EXISTS (
      SELECT 1 FROM semantic.hidden_candidate
      WHERE route = requested.route AND subject_id = requested.id AND candidate_id = live.id
        AND route >= input.partition_no * 16
        AND route < (input.partition_no + 1) * 16
      UNION ALL
      SELECT 1 FROM semantic.record_lifecycle
      WHERE route = requested.route AND subject_id = requested.id AND candidate_id = live.id
        AND state IN ('deleted', 'purging', 'purged')
        AND route >= input.partition_no * 16
        AND route < (input.partition_no + 1) * 16
      UNION ALL
      SELECT 1 FROM semantic.statement_disclosure d
      WHERE route = requested.route AND subject_id = requested.id AND candidate_id = live.id
        AND (NOT d.disclosed OR EXISTS (
          SELECT 1 FROM semantic.retraction t
          WHERE t.route = d.route AND t.route >= input.partition_no * 16
            AND t.route < (input.partition_no + 1) * 16
            AND t.subject_id = d.subject_id AND t.candidate_id = d.candidate_id
        ))
        AND route >= input.partition_no * 16
        AND route < (input.partition_no + 1) * 16
      )
    ORDER BY (body->>'rank' = 'preferred') DESC NULLS LAST, ordinal, id
    LIMIT 1
  ) AS picked
  LEFT JOIN LATERAL (
    SELECT revision, source FROM semantic.revision
    WHERE route = requested.route AND subject_id = requested.id
      AND (recorded_transaction_id = picked.support_transaction_id OR revision = picked.candidate_revision)
      AND route >= input.partition_no * 16
      AND route < (input.partition_no + 1) * 16
    LIMIT 1
  ) AS support ON true
) AS original ON true;
