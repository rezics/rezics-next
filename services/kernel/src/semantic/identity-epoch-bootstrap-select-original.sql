SELECT o.terminal,o.generation,o.present,g.pending_job FROM semantic.identity_epoch_original o
JOIN semantic.identity_epoch_group g ON (g.partition_no,g.terminal)=(o.partition_no,o.terminal)
WHERE o.partition_no=$1 AND o.original=$2 AND o.present FOR UPDATE OF o,g;
