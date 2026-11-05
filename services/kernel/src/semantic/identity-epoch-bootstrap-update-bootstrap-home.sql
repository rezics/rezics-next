UPDATE semantic.identity_epoch_bootstrap_home SET phase=$2,after_route=$3,after_original=$4,
        after_member=$5,generation=$6 WHERE partition_no=$1;
