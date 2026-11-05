SELECT 1 FROM semantic.identity_epoch_receiving_search_progress
WHERE partition_no=$1 AND job_id=$2 AND owner_id=$3 AND original=$4 AND state<>'released'
LIMIT 1;
