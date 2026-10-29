SELECT p.job_id,j.epoch FROM semantic.identity_epoch_admission_plan p
JOIN semantic.identity_epoch_job j ON j.job_id=p.job_id
WHERE p.resource_home=$1 AND p.waiting AND p.job_id>$2 AND j.state='preparing'
ORDER BY p.job_id LIMIT 100;
