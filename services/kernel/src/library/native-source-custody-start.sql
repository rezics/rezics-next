INSERT INTO library.native_source_capture
(route,capture_id,collection_id,account_id,incarnation,generation,scope,owner_epoch,receiving_epoch,effect_key,collection_fence,account_fence,driver)
VALUES (:route,:capture_id,:collection_id,:account_id,:incarnation,:generation,:scope,:owner_epoch,:receiving_epoch,:effect_key,:collection_fence,:account_fence,'member');
