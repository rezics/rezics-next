WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :subject_id::uuid AS subject_id,
         :candidate_ids::uuid[] AS candidate_ids
)
SELECT c.candidate_id::text AS candidate_id,
       CASE WHEN p.minimized AND NOT c.erasure_private THEN 'erased' ELSE b.principal_kind END AS principal_kind,
       b.principal_id::text AS principal_id,
       a.state AS account_state,
       a.authn_fenced AS account_fenced
FROM input i
JOIN semantic.candidate c
  ON c.route = i.route AND c.subject_id = i.subject_id AND c.candidate_id = ANY(i.candidate_ids)
JOIN semantic.revision r
  ON r.route = c.route AND r.subject_id = c.subject_id AND r.revision = c.revision
LEFT JOIN editorial.write_basis b
  ON b.partition_no = (i.route >> 4) AND b.transaction_id = r.recorded_transaction_id
LEFT JOIN semantic.erasure_provenance p
  ON p.partition_no=(i.route >> 4) AND p.transaction_id=r.recorded_transaction_id
LEFT JOIN access.account a
  ON b.principal_kind = 'account'
 AND a.route = get_byte(uuid_send(b.principal_id), 10) * 256 + get_byte(uuid_send(b.principal_id), 11)
 AND a.account_id = b.principal_id
WHERE NOT c.erasure_private AND (b.principal_kind IN ('account', 'anonymous') OR p.minimized)
