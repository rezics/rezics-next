SELECT plan.route AS route,plan.collection_id::text AS collection_id,plan.plan_key AS plan_key,
 plan.source_identity AS source_identity,plan.job_id::text AS job_id,plan.job_epoch::text AS job_epoch,
 plan.scope AS scope,plan.generation::text AS generation,plan.capture_id::text AS capture_id,
 plan.capture_frontier AS capture_frontier,plan.collection_fence::text AS collection_fence,
 plan.account_fence::text AS account_fence,plan.job_transaction_id::text AS job_transaction_id,
 CASE WHEN bounds.digest_valid THEN plan.scope_digest ELSE NULL END AS scope_digest,
 plan.job_writer_fence AS job_writer_fence,plan.phase AS phase,plan.driver AS driver,
 plan.after_subject::text AS after_subject,plan.after_fact::text AS after_fact,plan.version::text AS version,
 plan.state AS state,plan.old_head::text AS old_head,
 CASE WHEN bounds.old_state_valid THEN plan.old_state ELSE NULL END AS old_state,
 plan.seal_transaction_id::text AS seal_transaction_id,plan.frontier AS frontier,
 (bounds.digest_valid AND bounds.old_state_valid) AS projection_valid
FROM library.identity_scope_plan AS plan
CROSS JOIN LATERAL (
 SELECT plan.scope_digest ~ '^[0-9a-f]{64}$' AS digest_valid,
        (
          plan.old_state IS NULL OR (
            jsonb_typeof(plan.old_state)='object'
            AND plan.old_state=jsonb_build_object(
              'readyGeneration',plan.old_state->'readyGeneration',
              'readyBasis',plan.old_state->'readyBasis',
              'workingGeneration',plan.old_state->'workingGeneration',
              'workingBasis',plan.old_state->'workingBasis'
            )
            AND (
              plan.old_state->'readyGeneration'='null'::jsonb OR
              (jsonb_typeof(plan.old_state->'readyGeneration')='string' AND
               plan.old_state->>'readyGeneration' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
            )
            AND (
              plan.old_state->'readyBasis'='null'::jsonb OR
              (jsonb_typeof(plan.old_state->'readyBasis')='string' AND
               octet_length(plan.old_state->>'readyBasis') BETWEEN 1 AND 256)
            )
            AND (
              plan.old_state->'workingGeneration'='null'::jsonb OR
              (jsonb_typeof(plan.old_state->'workingGeneration')='string' AND
               plan.old_state->>'workingGeneration' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
            )
            AND (
              plan.old_state->'workingBasis'='null'::jsonb OR
              (jsonb_typeof(plan.old_state->'workingBasis')='string' AND
               octet_length(plan.old_state->>'workingBasis') BETWEEN 1 AND 256)
            )
            AND (plan.old_state->'readyGeneration'='null'::jsonb)=(plan.old_state->'readyBasis'='null'::jsonb)
            AND (plan.old_state->'workingGeneration'='null'::jsonb)=(plan.old_state->'workingBasis'='null'::jsonb)
          )
        ) AS old_state_valid
) AS bounds
WHERE plan.route=$1 AND plan.collection_id=$2 AND plan.plan_key=$3;
