WITH released AS (UPDATE search.identity_receiving_native_hold SET released_transaction_id=$4
WHERE partition_no=$1 AND plan_id=$2 AND hold_id=$3 AND released_transaction_id IS NULL
RETURNING partition_no,plan_id)
DELETE FROM search.identity_receiving_native_pending p USING released r
WHERE (p.partition_no,p.plan_id)=(r.partition_no,r.plan_id) AND p.physical_target=$5
RETURNING p.plan_id;
