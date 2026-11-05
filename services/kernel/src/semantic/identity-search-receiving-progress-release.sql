UPDATE semantic.identity_epoch_receiving_search_progress
SET state='released',revision=revision+1,released_transaction_id=$8
WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3
 AND accepted_transaction_id=$4 AND binding_digest=$5 AND revision=$6
 AND applied_transaction_id=$7 AND state='settled'
RETURNING revision;
