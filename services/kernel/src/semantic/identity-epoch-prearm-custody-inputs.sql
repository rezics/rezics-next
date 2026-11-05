-- Original input refs were inserted with the job's actual admission component.
-- Later input heads may advance, but cannot omit or substitute this native coverage.
SELECT s.original,s.terminal,s.generation,s.basis_version,s.control_partition,s.owner_epoch,
 n.transaction_id IS NOT NULL AS valid
FROM semantic.identity_epoch_admission_source s
LEFT JOIN semantic.identity_epoch_native_commit n ON n.partition_no=s.partition_no
 AND n.transaction_id=$3 AND n.purpose='admission' AND n.xmin=s.xmin
WHERE s.partition_no=$1 AND s.job_id=$2
ORDER BY s.original LIMIT 3;
