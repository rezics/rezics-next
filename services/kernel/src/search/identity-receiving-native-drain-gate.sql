SELECT consumer,owner_epoch,closed_token::text FROM search.identity_writer_gate
WHERE partition_no=$1 AND physical_target=$2 FOR UPDATE;
