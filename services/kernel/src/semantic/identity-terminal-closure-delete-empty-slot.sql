DELETE FROM semantic.identity_epoch_mapping_generation g
WHERE partition_no=$1 AND generation=$2 AND job_id=$2 AND closure_copies=0
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_group c
   WHERE c.partition_no=$1 AND c.closure_claim=$2)
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_page p
   WHERE p.partition_no=$1 AND p.closure_page_reservation=$2)
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_original o
   WHERE o.partition_no=$1 AND o.closure_reservation=$2)
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping m
   WHERE m.route/16=$1 AND m.closure_source_reservation=$2)
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping m
   WHERE m.route/16=$1 AND m.closure_ticket_reservation=$2)
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_terminal_closure_original o
   WHERE o.partition_no=$1 AND o.reservation=$2)
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_terminal_closure_ticket t
   WHERE t.partition_no=$1 AND t.reservation=$2)
