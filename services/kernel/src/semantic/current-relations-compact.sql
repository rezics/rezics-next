WITH input AS MATERIALIZED (
  SELECT *
  FROM jsonb_to_recordset(:candidates::jsonb) AS candidate(
    route integer,
    subject_id uuid,
    property text,
    candidate_id uuid,
    slot_id uuid,
    context_id uuid,
    defaults_suppress boolean,
    require_relation boolean
  )
), source AS MATERIALIZED (
  SELECT input.*, subject.visibility = 'visible' AS visible
  FROM input
  LEFT JOIN LATERAL (
    SELECT visibility
    FROM semantic.subject
    WHERE route = input.route AND subject_id = input.subject_id
    LIMIT 1
  ) AS subject ON true
), slot_state AS MATERIALIZED (
  SELECT source.*,
         slot_head.operation AS slot_operation
  FROM source
  LEFT JOIN LATERAL (
    SELECT operation
    FROM semantic.fact
    WHERE route = source.route AND subject_id = source.subject_id AND slot_id = source.slot_id
    ORDER BY log_seq DESC
    LIMIT 1
  ) AS slot_head ON true
), candidate_fact AS MATERIALIZED (
  SELECT slot_state.*,
         fact_release.kind AS fact_kind,
         fact_release.language AS fact_language,
         fact_release.property AS fact_property,
         fact_release.statement_id::text AS fact_statement_id,
         fact_release.operation AS fact_operation,
         fact_release.relation AS fact_relation,
         fact_release.body AS fact_body,
         fact_release.release AS fact_release,
         fact_release.revision AS fact_revision
  FROM slot_state
  LEFT JOIN LATERAL (
    SELECT f.kind, f.language, f.property, f.statement_id, f.operation, f.relation, f.body,
           revision.release, revision.revision
    FROM semantic.fact AS f
    JOIN semantic.revision AS revision
      ON revision.route = f.route AND revision.subject_id = f.subject_id
     AND revision.recorded_transaction_id = f.recorded_transaction_id
    WHERE f.route = slot_state.route AND f.subject_id = slot_state.subject_id
      AND f.slot_id = slot_state.slot_id AND f.statement_id = slot_state.candidate_id
      AND f.statement_id IS NOT NULL AND f.kind = 'statement'
    ORDER BY f.log_seq DESC
    LIMIT 1
  ) AS fact_release ON true
)
SELECT subject_id::text AS subject_id,
       candidate_id::text AS candidate_id,
       property AS requested_property,
       COALESCE(visible, false) AS visible,
       slot_operation = 'expand' AS expanded,
       CASE WHEN visible
                  AND slot_operation IS DISTINCT FROM 'expand'
                  AND (context_id = '00000000-0000-8000-8000-000000000000'::uuid OR NOT defaults_suppress)
                  AND fact_operation = 'assert'
                  AND fact_property = property
                  AND (NOT require_relation OR fact_relation)
            THEN fact_kind END AS kind,
       CASE WHEN visible
                  AND slot_operation IS DISTINCT FROM 'expand'
                  AND (context_id = '00000000-0000-8000-8000-000000000000'::uuid OR NOT defaults_suppress)
                  AND fact_operation = 'assert'
                  AND fact_property = property
                  AND (NOT require_relation OR fact_relation)
            THEN fact_language END AS language,
       CASE WHEN visible
                  AND slot_operation IS DISTINCT FROM 'expand'
                  AND (context_id = '00000000-0000-8000-8000-000000000000'::uuid OR NOT defaults_suppress)
                  AND fact_operation = 'assert'
                  AND fact_property = property
                  AND (NOT require_relation OR fact_relation)
            THEN fact_property END AS property,
       CASE WHEN visible
                  AND slot_operation IS DISTINCT FROM 'expand'
                  AND (context_id = '00000000-0000-8000-8000-000000000000'::uuid OR NOT defaults_suppress)
                  AND fact_operation = 'assert'
                  AND fact_property = property
                  AND (NOT require_relation OR fact_relation)
            THEN fact_statement_id END AS statement_id,
       CASE WHEN visible
                  AND slot_operation IS DISTINCT FROM 'expand'
                  AND (context_id = '00000000-0000-8000-8000-000000000000'::uuid OR NOT defaults_suppress)
                  AND fact_operation = 'assert'
                  AND fact_property = property
                  AND (NOT require_relation OR fact_relation)
            THEN fact_operation END AS operation,
       CASE WHEN visible
                  AND slot_operation IS DISTINCT FROM 'expand'
                  AND (context_id = '00000000-0000-8000-8000-000000000000'::uuid OR NOT defaults_suppress)
                  AND fact_operation = 'assert'
                  AND fact_property = property
                  AND (NOT require_relation OR fact_relation)
            THEN fact_body END AS body,
       CASE WHEN visible
                  AND slot_operation IS DISTINCT FROM 'expand'
                  AND (context_id = '00000000-0000-8000-8000-000000000000'::uuid OR NOT defaults_suppress)
                  AND fact_operation = 'assert'
                  AND fact_property = property
                  AND (NOT require_relation OR fact_relation)
            THEN fact_release END AS fact_release,
       CASE WHEN visible
                  AND slot_operation IS DISTINCT FROM 'expand'
                  AND (context_id = '00000000-0000-8000-8000-000000000000'::uuid OR NOT defaults_suppress)
                  AND fact_operation = 'assert'
                  AND fact_property = property
                  AND (NOT require_relation OR fact_relation)
            THEN fact_revision END AS fact_revision
FROM candidate_fact;
