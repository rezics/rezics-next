SELECT initialized,mode,ready,epoch,active_generation AS "activeGeneration",run_id AS "runId" FROM library.shelf_maintenance WHERE route=:route::integer AND account_id=:account_id::uuid FOR UPDATE;
