SELECT s.original FROM semantic.identity_epoch_admission_source s
JOIN semantic.identity_epoch_admission_validation v ON (v.partition_no,v.job_id,v.original)=(s.partition_no,s.job_id,s.original)
WHERE s.partition_no=$2 AND s.job_id=$1 AND v.source_home=s.route/16;
