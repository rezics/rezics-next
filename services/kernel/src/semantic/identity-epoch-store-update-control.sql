WITH parameters AS (SELECT $1::integer p1,$2::bigint p2,$3::uuid p3)
UPDATE semantic.identity_epoch_control SET allocated_epoch=(SELECT p2 FROM parameters),pending_epoch=(SELECT p2 FROM parameters),pending_job=(SELECT p3 FROM parameters) WHERE partition_no=(SELECT p1 FROM parameters);
