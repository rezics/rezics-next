SELECT terminal::text,epoch::text
FROM semantic.identity_epoch_mapping
WHERE route=$1 AND original=$2;
