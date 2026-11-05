SELECT control_partition,control_group::text,terminal::text,epoch::text,owner_epoch
FROM semantic.identity_epoch_mapping WHERE route=$1 AND original=$2;
