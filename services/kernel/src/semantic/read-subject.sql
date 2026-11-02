-- Drive every probe from the requested subject key. A join onto current_term_fact
-- can expand the view into a sequential scan of semantic.fact as unrelated history grows.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         (:route::integer / 16) AS partition_no
)
SELECT s.subject_id::text AS id, s.type, account.account_id::text AS account,
       s.security_revision::text AS security_revision,
       redirect.target::text AS redirect, latest.revision, latest.release,
       r.revision AS fact_revision, r.release AS fact_release,
       f.slot_id::text AS slot_id, f.log_seq, f.operation, f.kind,
       f.language, f.property, f.statement_id::text AS statement_id, f.body
FROM input
JOIN LATERAL (
  SELECT subject.subject_id, subject.type, subject.security_revision
  FROM semantic.subject AS subject
  WHERE subject.route = input.route AND subject.subject_id = input.subject_id
    AND subject.visibility = 'visible'
    AND subject.route >= input.partition_no * 16
    AND subject.route < (input.partition_no + 1) * 16
  LIMIT 1
) AS s ON true
LEFT JOIN LATERAL (
  SELECT agent.account_id
  FROM semantic.account_agent_subject AS agent
  WHERE agent.route = input.route AND agent.subject_id = input.subject_id
    AND agent.route >= input.partition_no * 16
    AND agent.route < (input.partition_no + 1) * 16
  LIMIT 1
) AS account ON true
LEFT JOIN LATERAL (
  SELECT redirect_row.target FROM semantic.redirect AS redirect_row
  WHERE redirect_row.route = input.route AND redirect_row.subject_id = input.subject_id
    AND redirect_row.route >= input.partition_no * 16
    AND redirect_row.route < (input.partition_no + 1) * 16
  ORDER BY redirect_row.sequence DESC
  LIMIT 1
) AS redirect ON true
LEFT JOIN LATERAL (
  SELECT revision_row.revision, revision_row.release FROM semantic.revision AS revision_row
  WHERE revision_row.route = input.route AND revision_row.subject_id = input.subject_id
    AND revision_row.route >= input.partition_no * 16
    AND revision_row.route < (input.partition_no + 1) * 16
  ORDER BY revision_row.revision DESC
  LIMIT 1
) AS latest ON true
LEFT JOIN LATERAL (
  SELECT fact.slot_id, fact.log_seq, fact.operation, fact.kind, fact.language, fact.property,
         fact.statement_id, fact.body, fact.recorded_transaction_id
  FROM (
    SELECT current_term.slot_id, current_term.log_seq, current_term.operation, current_term.kind,
           current_term.language, current_term.property, current_term.statement_id, current_term.body,
           current_term.recorded_transaction_id
    FROM semantic.current_term_fact AS current_term
    WHERE current_term.route = input.route AND current_term.subject_id = input.subject_id
      AND current_term.kind <> 'statement'
      AND current_term.route >= input.partition_no * 16
      AND current_term.route < (input.partition_no + 1) * 16
    OFFSET 0
  ) AS fact
) AS f ON true
LEFT JOIN LATERAL (
  SELECT revision_row.revision, revision_row.release FROM semantic.revision AS revision_row
  WHERE revision_row.route = input.route AND revision_row.subject_id = input.subject_id
    AND revision_row.recorded_transaction_id = f.recorded_transaction_id
    AND revision_row.route >= input.partition_no * 16
    AND revision_row.route < (input.partition_no + 1) * 16
  OFFSET 0
  LIMIT 1
) AS r ON true
ORDER BY f.slot_id, f.log_seq;
