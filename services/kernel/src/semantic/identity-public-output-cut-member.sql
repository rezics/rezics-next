SELECT 1 FROM semantic.identity_epoch_original
WHERE partition_no=$1 AND generation=$2 AND original=$3 AND terminal=$4 AND present FOR SHARE;
