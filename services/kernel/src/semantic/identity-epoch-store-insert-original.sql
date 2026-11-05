WITH parameters AS (SELECT $1::integer p1,$2::uuid p2,$3::uuid p3)
INSERT INTO semantic.identity_epoch_original(partition_no,generation,original,terminal,source_partition,source_generation,present)
      VALUES((SELECT p1 FROM parameters),(SELECT p2 FROM parameters),(SELECT p3 FROM parameters),(SELECT p3 FROM parameters),(SELECT p1 FROM parameters),0,true);
