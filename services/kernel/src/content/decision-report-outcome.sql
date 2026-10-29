WITH input AS (SELECT :security_revision::nullable(bigint) AS revision)
SELECT decision_id, decider_account_id,
       to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at
FROM content.moderation_decision
WHERE route = :route::integer AND target_kind = :target_kind::text AND target_id = :target_id::uuid
  AND ((SELECT revision FROM input) IS NULL OR security_revision = (SELECT revision FROM input))
ORDER BY security_revision DESC
LIMIT 1;
