WITH parameters AS (SELECT $1::integer p1,$2::uuid p2,$3::bigint p3,$4::uuid p4)
INSERT INTO semantic.identity_epoch_home_gate(route,destination,original,terminal,epoch,recorded_transaction_id)
      VALUES ((SELECT p1 FROM parameters),(SELECT p2 FROM parameters),(SELECT p2 FROM parameters),(SELECT p2 FROM parameters),(SELECT p3 FROM parameters),(SELECT p4 FROM parameters));
