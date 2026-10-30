SELECT segment,phase,cursor,build_generation AS "buildGeneration",input_identity AS "inputIdentity" FROM library.shelf_maintenance_step
 WHERE route=:route::integer AND account_id=:account_id::uuid AND run_id=:run_id::uuid AND epoch=:epoch::bigint AND sequence=:sequence::bigint;
