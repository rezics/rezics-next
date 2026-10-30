WITH input AS (SELECT :phase::text AS phase)
UPDATE library.shelf_maintenance_run SET epoch=:next_epoch::bigint,sequence=sequence+1,segment=:segment::integer,
 phase=(SELECT arg.phase FROM input arg),cursor=:cursor::jsonb,build_generation=:build_generation::nullable(uuid),enqueue_pending=((SELECT arg.phase FROM input arg)<>'complete')
 WHERE route=:route::integer AND account_id=:account_id::uuid AND run_id=:run_id::uuid AND epoch=:epoch::bigint AND sequence=:sequence::bigint AND NOT cancelled RETURNING sequence;
