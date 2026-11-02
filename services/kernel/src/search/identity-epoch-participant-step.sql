INSERT INTO semantic.identity_epoch_step
 (partition_no,transaction_id,native_epoch,native_position,job_id,job_epoch,step,version,scope_digest,frontier,state,work)
SELECT partition_no,transaction_id,epoch,position,$3,$4,'search-canonical-index',1,$5,$6,'more',$7
FROM semantic.identity_epoch_native_commit WHERE partition_no=$1 AND transaction_id=$2
 AND purpose='search-canonical-index'
RETURNING transaction_id;
