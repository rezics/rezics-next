INSERT INTO library.native_source_capture
(route,capture_id,collection_id,account_id,incarnation,generation,scope,owner_epoch,receiving_epoch,effect_key,collection_fence,account_fence,driver,output_generation,publication_transaction_id,publication_position)
VALUES (:route,:capture_id,:collection_id,:account_id,:incarnation,:generation,:scope,:owner_epoch,:receiving_epoch,:effect_key,:collection_fence,:account_fence,:driver,:output_generation,:publication_transaction_id,:publication_position);
