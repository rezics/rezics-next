SELECT identity_revision.revision,
       identity_revision.recorded_transaction_id::text AS "transactionId",
       current_redirect.target::text AS redirect
FROM semantic.subject AS subject
JOIN LATERAL (
  SELECT revision.revision, revision.recorded_transaction_id
  FROM semantic.revision AS revision
  WHERE revision.route = subject.route
    AND revision.subject_id = subject.subject_id
    AND revision.kind IN ('create', 'identity')
  ORDER BY revision.revision DESC
  LIMIT 1
) AS identity_revision ON true
LEFT JOIN LATERAL (
  SELECT redirect.target
  FROM semantic.redirect AS redirect
  WHERE redirect.route = subject.route
    AND redirect.subject_id = subject.subject_id
  ORDER BY redirect.sequence DESC
  LIMIT 1
) AS current_redirect ON true
WHERE subject.route = :route::integer
  AND subject.subject_id = :subject_id::uuid
  AND subject.visibility = 'visible';
