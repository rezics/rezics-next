-- Exact selected revision, current consent/retraction and original author binding.
SELECT wanted.id::text AS id, wanted.candidate::text AS candidate, r.source,
       CASE WHEN b.principal_kind='account' THEN b.principal_id::text END AS author, b.principal_kind, d.account_id::text AS consent_account,
       d.disclosed,
       EXISTS (SELECT 1 FROM semantic.retraction t WHERE t.route=wanted.route
         AND t.subject_id=wanted.id AND t.candidate_id=wanted.candidate) AS retracted
FROM jsonb_to_recordset($1::jsonb) wanted(route integer, id uuid, candidate uuid, revision integer)
JOIN LATERAL (
  SELECT source, recorded_transaction_id FROM semantic.revision
  WHERE route=wanted.route AND subject_id=wanted.id AND revision=wanted.revision LIMIT 1
) r ON true
LEFT JOIN LATERAL (
  SELECT principal_id, principal_kind FROM editorial.write_basis
  WHERE partition_no=$2::integer AND transaction_id=r.recorded_transaction_id LIMIT 1
) b ON true
LEFT JOIN LATERAL (
  SELECT account_id, disclosed FROM semantic.statement_disclosure
  WHERE route=wanted.route AND subject_id=wanted.id AND candidate_id=wanted.candidate LIMIT 1
) d ON true
ORDER BY wanted.id, wanted.candidate;
