SELECT s.* FROM semantic.identity_epoch_step s
        JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id,c.epoch,c.position)=
          (s.partition_no,s.transaction_id,s.native_epoch,s.native_position)
        WHERE s.partition_no=$1 AND s.transaction_id=$2 AND s.native_epoch=$3 AND s.native_position=$4
        AND s.job_id=$5 AND s.job_epoch=$6 AND s.step=$7 AND s.version=1 AND c.purpose=s.step
        AND s.xmin=c.xmin;
