SELECT collection_id FROM library.collection WHERE route=:route::integer AND collection_id=:collection_id::uuid
 AND curator_account_id=:account_id::uuid LIMIT 1;
