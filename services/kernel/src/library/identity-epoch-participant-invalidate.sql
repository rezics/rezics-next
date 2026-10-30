-- One exact source, including BOTH working and ready generations. No fact enumeration/deletion.
-- The detached basis remains retained through uncertainty; this is not a repair/ready receipt.
WITH prior AS MATERIALIZED (
  SELECT ready_generation,ready_basis,working_generation,working_basis
  FROM library.canonical_source_state
  WHERE route=$1 AND collection_id=$2
  FOR UPDATE
), retained AS (
  INSERT INTO library.identity_epoch_source_basis
    (partition_no,job_id,job_epoch,effect_key,source_route,source_id,owner_id,
     ready_generation,ready_basis,working_generation,working_basis)
  SELECT $3,$4,$5,$6,$1,$2,$7,ready_generation,ready_basis,working_generation,working_basis
  FROM prior
  RETURNING ready_generation,working_generation
), invalidated AS (
  UPDATE library.canonical_source_state
  SET ready_generation=NULL,ready_basis=NULL,working_generation=NULL,working_basis=NULL,
      after_subject_id=NULL,after_driver=NULL,after_fact_id=NULL,
      pending_mapping=true,source_exhausted=false
  WHERE route=$1 AND collection_id=$2 AND EXISTS(SELECT 1 FROM retained)
  RETURNING collection_id
)
SELECT ready_generation::text,working_generation::text FROM retained
WHERE EXISTS(SELECT 1 FROM invalidated);
