SELECT true AS current FROM library.shelf_maintenance
WHERE route = :route::integer AND account_id = :account_id::uuid AND epoch = :epoch::bigint
  AND initialized AND mode = 'open';
