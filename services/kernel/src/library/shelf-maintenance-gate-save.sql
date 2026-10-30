UPDATE library.shelf_maintenance SET initialized=true,mode=:mode::text,ready=:ready::boolean,
 epoch=:epoch::bigint, active_generation=:active_generation::nullable(uuid),run_id=:run_id::nullable(uuid) WHERE route=:route::integer AND account_id=:account_id::uuid;
