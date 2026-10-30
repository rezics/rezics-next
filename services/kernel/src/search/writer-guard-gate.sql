/* search:writer-guard:gate */
INSERT INTO search.identity_writer_gate
  (partition_no,physical_target,consumer,incarnation,owner_epoch,write_alias)
VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (partition_no,physical_target) DO UPDATE
  SET enrollment_generation=identity_writer_gate.enrollment_generation
  WHERE identity_writer_gate.consumer=EXCLUDED.consumer
    AND identity_writer_gate.incarnation=EXCLUDED.incarnation
    AND identity_writer_gate.write_alias=EXCLUDED.write_alias
    AND identity_writer_gate.owner_epoch=EXCLUDED.owner_epoch
RETURNING enrollment_generation, fence_generation, closed_token;
