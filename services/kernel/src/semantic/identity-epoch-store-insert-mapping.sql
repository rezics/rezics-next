WITH parameters AS (SELECT $1::integer p1,$2::uuid p2,$3::bigint p3,$4::uuid p4,$5::integer p5)
INSERT INTO semantic.identity_epoch_mapping(route,original,terminal,epoch,origin,recorded_transaction_id,control_partition,control_group,owner_epoch)
      VALUES ((SELECT p1 FROM parameters),(SELECT p2 FROM parameters),(SELECT p2 FROM parameters),(SELECT p3 FROM parameters),'creation',(SELECT p4 FROM parameters),(SELECT p5 FROM parameters),(SELECT p2 FROM parameters),(SELECT p3 FROM parameters));
