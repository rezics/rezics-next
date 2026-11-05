WITH input AS (SELECT :route::integer AS route,:account_id::uuid AS account_id,:run_id::uuid AS run_id,:subject_id::uuid AS subject_id), removed AS (
 DELETE FROM library.shelf_maintenance_source s USING input i
 WHERE s.route=i.route AND s.account_id=i.account_id AND s.run_id=i.run_id AND s.subject_id=i.subject_id RETURNING s.reservation_id)
 DELETE FROM library.shelf_type_reservation r USING input i,removed s
 WHERE r.route=i.route AND r.account_id=i.account_id AND r.maintenance_run_id=i.run_id AND r.reservation_id=s.reservation_id;
