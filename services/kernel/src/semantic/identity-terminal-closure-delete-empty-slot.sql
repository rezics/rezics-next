WITH input AS (SELECT $1::integer AS home, $2::uuid AS reservation)
DELETE FROM semantic.identity_epoch_mapping_generation g USING input i
WHERE g.partition_no=i.home AND g.generation=i.reservation AND g.job_id=i.reservation AND g.closure_copies=0
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_group c
   WHERE c.partition_no=i.home AND c.closure_claim=i.reservation)
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_page p
   WHERE p.partition_no=i.home AND p.closure_page_reservation=i.reservation)
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_original o
   WHERE o.partition_no=i.home AND o.closure_reservation=i.reservation)
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping m
   WHERE m.route/16=i.home AND m.closure_source_reservation=i.reservation)
 AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping m
   WHERE m.route/16=i.home AND m.closure_ticket_reservation=i.reservation)
