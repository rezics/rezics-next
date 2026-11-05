SELECT root_digest,phase,origin,input_digest,episode,deadline_ms::text,admitted,spent,position::text,state,
 dispatch_transaction_id,terminal_transaction_id,result_digest
FROM semantic.definition_catalogue_original WHERE route=0 AND original_key=:original_key::text LIMIT 1 FOR UPDATE;
