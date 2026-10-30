SELECT h.job_id,h.job_epoch AS epoch FROM semantic.identity_epoch_admission_handoff h
LEFT JOIN semantic.identity_epoch_admission_attempt a ON (a.partition_no,a.job_id)=(h.partition_no,h.job_id)
WHERE h.partition_no=$1 AND h.job_id>$2 AND a.job_id IS NULL ORDER BY h.job_id LIMIT 100;
