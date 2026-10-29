UPDATE semantic.identity_epoch_bootstrap_topology SET next_partition=($1+1)%4096,remaining=remaining-$2 WHERE partition_no=0;
