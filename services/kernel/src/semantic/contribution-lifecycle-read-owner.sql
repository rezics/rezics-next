-- The locator supplies the original revision, including for an unexpanded compact assertion.
-- Exact keyed author/publication witnesses; no payload or author profile is hydrated.
SELECT (
  NOT coalesce(c.erasure_private, false)
  AND (
    coalesce(p.minimized, false)
    OR b.principal_kind = 'anonymous'
    OR (b.principal_kind = 'account' AND a.state = 'active' AND NOT a.authn_fenced)
  )
) AS visible
FROM semantic.revision r
LEFT JOIN semantic.candidate c
  ON c.route = r.route AND c.subject_id = r.subject_id AND c.candidate_id = :candidate_id::uuid
LEFT JOIN editorial.write_basis b
  ON b.partition_no = (r.route >> 4) AND b.transaction_id = r.recorded_transaction_id
LEFT JOIN semantic.erasure_provenance p
  ON p.partition_no = (r.route >> 4) AND p.transaction_id = r.recorded_transaction_id
LEFT JOIN access.account a
  ON b.principal_kind = 'account' AND a.account_id = b.principal_id
  AND a.route = get_byte(uuid_send(b.principal_id), 10) * 256 + get_byte(uuid_send(b.principal_id), 11)
WHERE r.route = :route::integer AND r.subject_id = :subject_id::uuid AND r.revision = :revision::integer;
