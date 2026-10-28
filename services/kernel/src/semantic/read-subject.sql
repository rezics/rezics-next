WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id
)
SELECT s.subject_id::text AS id, s.type, account.account_id::text AS account,
       s.security_revision::text AS security_revision,
       redirect.target::text AS redirect, latest.revision, latest.release,
       r.revision AS fact_revision, r.release AS fact_release,
       f.slot_id::text AS slot_id, f.log_seq, f.operation, f.kind,
       f.language, f.property, f.statement_id::text AS statement_id, f.body
FROM semantic.subject AS s
CROSS JOIN input
LEFT JOIN semantic.account_agent_subject AS account
  ON account.route = input.route AND account.subject_id = input.subject_id
LEFT JOIN LATERAL (
  SELECT redirect_row.target FROM semantic.redirect AS redirect_row
  CROSS JOIN input
  WHERE redirect_row.route = input.route AND redirect_row.subject_id = input.subject_id
  ORDER BY redirect_row.sequence DESC LIMIT 1
) AS redirect ON true
LEFT JOIN LATERAL (
  SELECT revision_row.revision, revision_row.release FROM semantic.revision AS revision_row
  CROSS JOIN input
  WHERE revision_row.route = input.route AND revision_row.subject_id = input.subject_id
  ORDER BY revision_row.revision DESC LIMIT 1
) AS latest ON true
LEFT JOIN semantic.fact AS f
  ON f.route = input.route AND f.subject_id = input.subject_id AND f.kind <> 'statement'
LEFT JOIN LATERAL (
  SELECT revision_row.revision, revision_row.release FROM semantic.revision AS revision_row
  CROSS JOIN input
  WHERE revision_row.route = input.route AND revision_row.subject_id = input.subject_id
    AND revision_row.recorded_transaction_id = f.recorded_transaction_id
  LIMIT 1
) AS r ON true
WHERE s.route = input.route AND s.subject_id = input.subject_id AND s.visibility = 'visible'
ORDER BY f.slot_id, f.log_seq;
