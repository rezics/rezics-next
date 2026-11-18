-- unbound: exact routed account and Subject keys on one physical database in a single statement snapshot.
-- The public floor suffices for this native Access profile only with complete direct-account denial evidence.
WITH viewer AS MATERIALIZED (
  SELECT a.account_id, a.operator_relation_version, p.epoch, c.generation, c.epoch AS auth_epoch
  FROM access.account a
  JOIN core.partition p ON p.partition_no = ($1::integer >> 4) AND p.write_state = 'active' AND p.moved_to IS NULL
  JOIN core.publication_authority_epoch c ON c.home_no = p.partition_no
  WHERE (a.route, a.account_id) = ($1, $2::uuid) AND a.kind = 'actor' AND a.state = 'active'
    AND $7::timestamptz >= $8::timestamptz
    AND NOT a.authn_fenced AND a.operator_account_id IS NULL AND a.membership_inverse_complete
    AND a.minimum_authn_epoch = $3::bigint AND a.transaction_id = $4::uuid
    AND NOT EXISTS (SELECT 1 FROM access.membership_inverse m WHERE (m.route, m.account_id) = ($1, $2))
    AND NOT EXISTS (SELECT 1 FROM access.erasure e WHERE (e.route, e.account_id) = ($1, $2))
), requested AS MATERIALIZED (
  SELECT DISTINCT route, id FROM unnest($5::integer[], $6::uuid[]) k(route, id)
)
SELECT k.id::text, s.visibility, s.security_revision::text, s.erasure_key::text, s.current_release,
       s.recorded_transaction_id::text AS birth, v.revision, v.recorded_transaction_id::text AS version,
       v.erasure_key::text AS revision_key, v.release,
       r.target::text, r.sequence, r.recorded_transaction_id::text AS redirect_version, r.erasure_key::text AS redirect_key,
       p.epoch, c.generation::text, c.epoch::text AS auth_epoch,
       a.epoch AS viewer_epoch, a.generation::text AS viewer_generation, a.auth_epoch::text AS viewer_auth_epoch,
       a.operator_relation_version::text,
       EXISTS (SELECT 1 FROM access.resource_denial d
         WHERE d.route = k.route AND d.resource_id = k.id AND d.action = 'subject:read'
           AND d.subject_id = a.account_id AND d.subject_role = '' AND d.valid @> $7::timestamptz) AS denied
FROM viewer a LEFT JOIN (requested k
JOIN LATERAL (SELECT epoch FROM core.partition WHERE partition_no = (k.route >> 4)
              AND write_state = 'active' AND moved_to IS NULL LIMIT 1) p ON true
JOIN LATERAL (SELECT generation, epoch FROM core.publication_authority_epoch
              WHERE home_no = (k.route >> 4) LIMIT 1) c ON true
JOIN LATERAL (SELECT visibility, security_revision, erasure_key, recorded_transaction_id, current_release
              FROM semantic.subject WHERE (route, subject_id) = (k.route, k.id)
                AND CASE WHEN octet_length(current_release) = 71 THEN current_release ~ '^sha256:[0-9a-f]{64}$' ELSE false END
              LIMIT 1) s ON true
JOIN LATERAL (SELECT revision, recorded_transaction_id, erasure_key, release FROM semantic.revision
              WHERE (route, subject_id) = (k.route, k.id) ORDER BY revision DESC LIMIT 1) v ON true
LEFT JOIN LATERAL (SELECT target, sequence, recorded_transaction_id, erasure_key FROM semantic.redirect
                   WHERE (route, subject_id) = (k.route, k.id) ORDER BY sequence DESC LIMIT 1) r ON true
) ON true;
