-- The graph address writers are gone. Retire their pending dispatches so a
-- later strong revocation never asks an absent owner to seal them. Epoch zero
-- marks this SQL-only cancellation, not a fabricated native graph position.
WITH terminal AS (
 UPDATE access.admission SET state = 'sealed',graph_outcome = 'cancelled',
   graph_receipt = 'urn:rezics:retired-address-admission:' || id::text,
   graph_data_epoch = COALESCE(graph_data_epoch,'00000000-0000-0000-0000-000000000000'),
   graph_sequence = COALESCE(graph_sequence,'0'),sealed_at = clock_timestamp()
 WHERE action IN ('address.claim','address.rename','address.dispose') AND state <> 'sealed'
 RETURNING id,scope_id,authority_epoch
)
INSERT INTO access.outbox(id,kind,admission_id,scope_id,authority_epoch)
 SELECT gen_random_uuid(),'admission.sealed',id,scope_id,authority_epoch FROM terminal;
