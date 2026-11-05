WITH input AS (SELECT $5::integer AS epoch,$6::bigint AS position)
SELECT p.sequence,p.page_id,p.original,p.scope,p.registration,p.capture_id,
 p.transaction_id,e.epoch AS export_epoch,e.position AS export_position,
 (e.transaction_id IS NOT NULL AND c.transaction_id IS NOT NULL
 AND (p.original IS NULL OR (m.original IS NOT NULL AND v.source_receipt IS NOT NULL
 AND p.scope<>'{}'::jsonb AND p.capture_id<>'' AND p.registration IS NOT NULL))) AS valid
FROM semantic.identity_epoch_prearm_page p
LEFT JOIN semantic.identity_epoch_native_commit e ON e.partition_no=p.partition_no
 AND e.transaction_id=p.transaction_id AND e.xmin=p.xmin AND e.epoch=(SELECT epoch FROM input) AND e.position<=(SELECT position FROM input)
 AND e.purpose IN ('admission','identity-prearm')
LEFT JOIN semantic.identity_epoch_prearm_disposition v ON v.partition_no=p.partition_no AND v.page_id=p.page_id AND v.stage='unsafe'
LEFT JOIN semantic.identity_epoch_native_commit c ON c.partition_no=v.partition_no AND c.transaction_id=v.transaction_id
 AND c.xmin=v.xmin AND c.epoch=(SELECT epoch FROM input) AND c.position<=(SELECT position FROM input) AND c.purpose IN ('admission','identity-prearm')
LEFT JOIN semantic.identity_epoch_original m ON m.partition_no=p.partition_no AND m.generation=p.generation AND m.original=p.original
WHERE p.partition_no=$1 AND p.job_id=$2 AND p.generation=$3 AND p.sequence>$4
ORDER BY p.sequence LIMIT $7;
