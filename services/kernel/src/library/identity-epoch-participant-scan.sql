WITH input AS (
  SELECT $1::integer AS partition_no, $2::uuid AS job_id, $3::bigint AS job_epoch
), inputs AS (
  SELECT i.generation,i.terminal,i.prearm_sequence,i.prearm_transaction_id,i.prearm_epoch,i.prearm_position,
         i.control_partition
  FROM input
  JOIN semantic.identity_epoch_input i USING (partition_no,job_id)
  ORDER BY i.terminal LIMIT 3
), originals AS NOT MATERIALIZED (
  SELECT o.original
  FROM inputs i
  JOIN semantic.identity_epoch_original o
    ON o.partition_no=i.control_partition AND o.generation=i.generation AND o.terminal=i.terminal
    AND o.present
), directory AS (
  -- Admission copies an attested final empty page for each input. A later EOF does
  -- not prove an empty affected scope: the earlier pages may name public output.
  SELECT count(*) BETWEEN 1 AND 2 AND bool_and((
    i.prearm_sequence=1 AND d.empty AND d.source_receipt IS NULL
    AND d.directory_partition=i.control_partition
    AND d.directory_receipt->>'transactionId'=i.prearm_transaction_id::text
    AND d.directory_receipt->>'epoch'=i.prearm_epoch::text
    AND d.directory_receipt->>'position'=i.prearm_position::text
    AND n.transaction_id IS NOT NULL
  ) IS TRUE) AS empty
  FROM input CROSS JOIN inputs i
  LEFT JOIN semantic.identity_epoch_prearm_custody d
    ON d.partition_no=input.partition_no AND d.job_id=input.job_id AND d.generation=i.generation AND d.sequence=1
  LEFT JOIN core.partition o ON o.partition_no=input.partition_no
  LEFT JOIN semantic.identity_epoch_native_commit n
    ON n.partition_no=d.partition_no AND n.transaction_id=d.transaction_id
    AND n.purpose IN ('admission','identity-prearm') AND n.xmin=d.xmin
    AND n.epoch=o.epoch AND n.position<=o.position
)
SELECT bool_or(probe.building) AS building, bool_or(probe.affected) AS affected,
       (SELECT empty FROM directory) AS directory_empty
FROM input
CROSS JOIN generate_series(input.partition_no * 16, input.partition_no * 16 + 15) AS home(route)
CROSS JOIN LATERAL (
  SELECT
    EXISTS (
      SELECT 1 FROM library.identity_scope_plan p
      WHERE p.route=home.route AND p.job_id=input.job_id AND p.job_epoch=input.job_epoch AND p.state='building'
    ) AS building,
    (
      EXISTS (
        SELECT 1 FROM library.collection_member m
        JOIN originals o ON o.original=m.subject_id
        WHERE m.route=home.route AND m.deletion_id IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM library.collection_source_output_member m
        JOIN originals o ON o.original=m.subject_id
        WHERE m.route=home.route
          AND (
            -- The terminal disposer removes the account publication row after successor custody.
            EXISTS (
              SELECT 1 FROM library.collection_retained_output f
              WHERE f.route=m.route AND f.collection_id=m.collection_id AND f.generation=m.generation
            )
            OR EXISTS (
              SELECT 1 FROM library.collection_source_output_publication p
              WHERE p.route=m.route AND p.collection_id=m.collection_id AND p.generation=m.generation
                AND (
                  EXISTS (
                    SELECT 1 FROM library.collection_source_output_head h
                    WHERE h.route=p.route AND h.collection_id=p.collection_id AND h.generation=p.generation
                      AND h.source_generation=p.source_generation
                  )
                  OR EXISTS (
                    SELECT 1 FROM library.native_public_output_hold h
                    WHERE h.route=p.route AND h.collection_id=p.collection_id AND h.output_generation=p.generation
                      AND h.activation_transaction_id=p.transaction_id AND h.activation_source_generation=p.source_generation
                      AND h.consumed_by IS NULL
                  )
                )
            )
          )
      )
    ) AS affected
) AS probe;
