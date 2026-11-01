WITH parameters AS (SELECT $1::integer AS p1, $2::uuid AS p2, $3::uuid AS p3, $4::integer AS p4, $5::bigint AS p5), b AS (
 INSERT INTO semantic.identity_epoch_prearm_bridge(partition_no,generation,terminal,owner_epoch,basis_version)
 VALUES((SELECT p1 FROM parameters),(SELECT p2 FROM parameters),(SELECT p3 FROM parameters),(SELECT p4 FROM parameters),(SELECT p5 FROM parameters)) ON CONFLICT DO NOTHING
)
INSERT INTO semantic.identity_scope_bridge(partition_no,generation) VALUES((SELECT p1 FROM parameters),(SELECT p2 FROM parameters)) ON CONFLICT DO NOTHING;
