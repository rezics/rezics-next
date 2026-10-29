UPDATE semantic.identity_epoch_group SET observed_count=observed_count+$2,version=version+1
            WHERE terminal=$1;
