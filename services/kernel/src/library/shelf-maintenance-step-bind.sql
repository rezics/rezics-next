UPDATE library.shelf_maintenance_step SET input_identity=:identity::nullable(jsonb)
 WHERE route=:route::integer AND account_id=:account_id::uuid AND run_id=:run_id::uuid AND epoch=:epoch::bigint
 AND sequence=:sequence::bigint AND input_identity IS NULL RETURNING sequence;
