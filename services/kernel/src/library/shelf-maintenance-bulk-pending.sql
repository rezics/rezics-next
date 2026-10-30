SELECT operation_id FROM library.bulk_target
WHERE route=:route::integer AND account_id=:account_id::uuid ORDER BY operation_id,ordinal LIMIT 1;
