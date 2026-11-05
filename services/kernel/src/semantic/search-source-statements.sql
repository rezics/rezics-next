WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
),
entries AS MATERIALIZED (
  SELECT *
  FROM jsonb_to_recordset(:entries::jsonb) AS entry(
    source text,
    route integer,
    subject_id uuid,
    slot_id uuid,
    property text,
    candidate_id uuid,
    rank text,
    ordinal integer,
    body jsonb,
    release text
  )
)
SELECT entry.subject_id::text AS subject_id,
       entry.slot_id::text AS slot_id,
       entry.property,
       entry.candidate_id::text AS candidate_id,
       entry.rank,
       CASE WHEN entry.source = 'compact' THEN entry.body ELSE candidate.statement END AS body,
       CASE WHEN entry.source = 'compact' THEN entry.release ELSE candidate.release END AS release,
       entry.ordinal
FROM entries entry
LEFT JOIN LATERAL (
  SELECT statement, release
  FROM semantic.candidate
  CROSS JOIN input
  WHERE entry.source = 'expanded'
    AND route = entry.route AND subject_id = entry.subject_id AND candidate_id = entry.candidate_id
    AND NOT relation
    AND route >= input.partition_no * 16
    AND route < (input.partition_no + 1) * 16
  LIMIT 1
) candidate ON true
LEFT JOIN LATERAL (
  SELECT 1
  FROM semantic.hidden_candidate hidden
  CROSS JOIN input
  WHERE hidden.route = entry.route AND hidden.subject_id = entry.subject_id
    AND hidden.candidate_id = entry.candidate_id
    AND hidden.route >= input.partition_no * 16
    AND hidden.route < (input.partition_no + 1) * 16
  UNION ALL
  SELECT 1 FROM semantic.record_lifecycle lifecycle
  CROSS JOIN input
  WHERE lifecycle.route=entry.route AND lifecycle.subject_id=entry.subject_id
    AND lifecycle.candidate_id=entry.candidate_id AND lifecycle.state IN ('deleted','purging','purged')
    AND lifecycle.route >= input.partition_no * 16 AND lifecycle.route < (input.partition_no + 1) * 16
  UNION ALL
  SELECT 1 FROM semantic.statement_disclosure d
  CROSS JOIN input
  WHERE d.route = entry.route AND d.subject_id = entry.subject_id AND d.candidate_id = entry.candidate_id
    AND (NOT d.disclosed OR EXISTS (SELECT 1 FROM semantic.retraction t
      WHERE t.route = d.route AND t.route >= input.partition_no * 16 AND t.route < (input.partition_no + 1) * 16 AND t.subject_id = d.subject_id AND t.candidate_id = d.candidate_id)) AND d.route >= input.partition_no * 16 AND d.route < (input.partition_no + 1) * 16
  LIMIT 1
) concealed ON true
WHERE concealed IS NULL
  AND (entry.source = 'compact' OR candidate.statement IS NOT NULL)
ORDER BY entry.route, entry.subject_id, entry.slot_id, entry.ordinal;
