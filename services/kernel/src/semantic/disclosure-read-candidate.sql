WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :subject_id::uuid AS subject_id,
         :candidate_id::uuid AS candidate_id
)
SELECT s.visibility,
       s.security_revision::text AS security_revision,
       (c.candidate_id IS NOT NULL OR f.statement_id IS NOT NULL) AS known,
       (coalesce(c.erasure_private,false) OR h.candidate_id IS NOT NULL OR d.candidate_id IS NOT NULL OR
         (b.principal_kind = 'account' AND
           (a.account_id IS NULL OR a.state <> 'active' OR a.authn_fenced))) AS hidden
FROM input i
JOIN semantic.subject s
  ON s.route = i.route AND s.subject_id = i.subject_id
LEFT JOIN semantic.candidate c
  ON c.route = i.route AND c.subject_id = s.subject_id AND c.candidate_id = i.candidate_id
LEFT JOIN LATERAL (
  SELECT fact.statement_id
  FROM semantic.fact fact
  WHERE fact.route = i.route AND fact.subject_id = s.subject_id AND fact.statement_id = i.candidate_id
    AND fact.kind = 'statement' AND fact.operation = 'assert'
    AND NOT EXISTS (
      SELECT 1 FROM semantic.fact newer
      WHERE newer.route = i.route AND newer.subject_id = fact.subject_id
        AND newer.slot_id = fact.slot_id AND newer.statement_id = fact.statement_id
        AND newer.log_seq > fact.log_seq
    )
  LIMIT 1
) f ON true
LEFT JOIN semantic.statement_disclosure d
  ON d.route = i.route AND d.subject_id = s.subject_id AND d.candidate_id = i.candidate_id AND (NOT d.disclosed OR EXISTS (SELECT 1 FROM semantic.retraction t
    WHERE t.route = i.route AND t.subject_id = d.subject_id AND t.candidate_id = d.candidate_id))
LEFT JOIN semantic.hidden_candidate h
  ON h.route = i.route AND h.subject_id = s.subject_id AND h.candidate_id = i.candidate_id
LEFT JOIN semantic.revision r
  ON r.route = c.route AND r.subject_id = c.subject_id AND r.revision = c.revision
LEFT JOIN editorial.write_basis b
  ON b.partition_no = (i.route >> 4) AND b.transaction_id = r.recorded_transaction_id
LEFT JOIN access.account a
  ON b.principal_kind = 'account'
 AND a.route = get_byte(uuid_send(b.principal_id), 10) * 256 + get_byte(uuid_send(b.principal_id), 11)
 AND a.account_id = b.principal_id;
