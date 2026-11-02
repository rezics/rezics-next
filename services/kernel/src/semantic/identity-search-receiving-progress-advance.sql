WITH input AS (SELECT $9::uuid AS applied)
UPDATE semantic.identity_epoch_receiving_search_progress
SET revision=revision+1,after_key=$7,state=$8,applied_transaction_id=input.applied
FROM input
WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3
 AND accepted_transaction_id=$4 AND binding_digest=$5 AND revision=$6
 AND state='progress' AND (applied_transaction_id IS NULL OR applied_transaction_id=input.applied)
RETURNING revision;
