-- Structural dependency observation only. The original producer must admit this
-- exact home and Accounts must decide the audience before include_type is true.
-- Native Type is not a statement and has no invented imported-field tuple.
SELECT wanted.subject_id::text AS subject_id,
       (s.subject_id IS NOT NULL) AS present,
       (f.subject_id IS NOT NULL) AS writer_enrolled,
       COALESCE(f.version, 0)::text AS writer_version,
       s.visibility, s.security_revision::text AS security_revision,
       CASE WHEN octet_length(s.current_release) = 71
                      AND s.current_release ~ '^sha256:[0-9a-f]{64}$'
            THEN s.current_release END AS current_release,
       CASE WHEN wanted.include_type AND s.visibility = 'visible'
                  AND octet_length(s.type) <= wanted.max_type_bytes
            THEN s.type END AS type,
       CASE WHEN wanted.include_type AND s.visibility = 'visible'
            THEN octet_length(s.type) > wanted.max_type_bytes ELSE false END AS type_oversized,
       r.revision, r.recorded_transaction_id::text AS revision_transaction,
       rb.epoch AS revision_epoch, rb.position::text AS revision_position,
       d.target::text AS redirect, d.sequence AS redirect_sequence,
       d.recorded_transaction_id::text AS redirect_transaction,
       db.epoch AS redirect_epoch, db.position::text AS redirect_position,
       agent.account_id::text AS account_id
FROM (SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
             :include_type::boolean AS include_type, :max_type_bytes::integer AS max_type_bytes) wanted
LEFT JOIN semantic.subject s
  ON s.route = wanted.route AND s.subject_id = wanted.subject_id
LEFT JOIN semantic.kind_type_anchor_fence f
  ON f.route = wanted.route AND f.subject_id = wanted.subject_id
LEFT JOIN LATERAL (
  SELECT revision, recorded_transaction_id FROM semantic.revision
  WHERE route = wanted.route AND subject_id = wanted.subject_id
  ORDER BY revision DESC LIMIT 1
) r ON true
-- Account erasure can DELETE native write_basis rows. The subject-key fence
-- alone does not serialize that writer. Hold the exact existing provenance row
-- through local commit, including against metadata UPDATE, without foreign IO.
LEFT JOIN LATERAL (
  SELECT epoch, position FROM editorial.write_basis
  WHERE partition_no = wanted.route / 16 AND transaction_id = r.recorded_transaction_id
  FOR SHARE
) rb ON true
LEFT JOIN LATERAL (
  SELECT sequence, target, recorded_transaction_id FROM semantic.redirect
  WHERE route = wanted.route AND subject_id = wanted.subject_id
  ORDER BY sequence DESC LIMIT 1
) d ON true
LEFT JOIN LATERAL (
  SELECT epoch, position FROM editorial.write_basis
  WHERE partition_no = wanted.route / 16 AND transaction_id = d.recorded_transaction_id
  FOR SHARE
) db ON true
LEFT JOIN semantic.account_agent_subject agent
  ON agent.route = wanted.route AND agent.subject_id = wanted.subject_id;
