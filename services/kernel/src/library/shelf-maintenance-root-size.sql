SELECT v.byte_length AS bytes
FROM library.shelf_type_root r JOIN library.shelf_type_value v
  ON v.route=r.route AND v.account_id=r.account_id AND v.type_id=r.primary_type_id
WHERE r.route=:route::integer AND r.account_id=:account_id::uuid AND r.digest=:digest::bytea
LIMIT 1;
