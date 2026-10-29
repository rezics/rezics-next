WITH parameters AS (SELECT $1::integer p1,$2::bigint p2,$3::integer p3,$4::integer p4)
UPDATE semantic.identity_epoch_bootstrap_home SET sealed_generation=(SELECT p2 FROM parameters),needs_work=false WHERE partition_no=(SELECT p1 FROM parameters)
        AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_dirty WHERE route BETWEEN (SELECT p3 FROM parameters) AND (SELECT p4 FROM parameters) AND revision>captured_revision)
        AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_member_dirty WHERE route BETWEEN (SELECT p3 FROM parameters) AND (SELECT p4 FROM parameters) AND revision>captured_revision) RETURNING sealed_generation;
