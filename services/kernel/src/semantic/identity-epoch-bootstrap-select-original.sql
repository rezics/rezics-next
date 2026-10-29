SELECT terminal,generation,present FROM semantic.identity_epoch_original
            WHERE partition_no=$1 AND original=$2 AND present FOR UPDATE;
