-- One exact source, including BOTH working and ready generations. No fact enumeration/deletion.
-- The detached basis remains retained through uncertainty; this is not a repair/ready receipt.
WITH input AS NOT MATERIALIZED (
  SELECT $1::integer AS source_route,$2::uuid AS source_id,$3::integer AS partition_no,
         $4::uuid AS job_id,$5::bigint AS job_epoch,$6::text AS effect_key,$7::uuid AS owner_id
), prior AS MATERIALIZED (
  SELECT s.ready_generation,s.ready_basis,s.working_generation,s.working_basis
  FROM library.canonical_source_state s CROSS JOIN input i
  WHERE s.route=i.source_route AND s.collection_id=i.source_id
  FOR UPDATE OF s
), retained AS (
  INSERT INTO library.identity_epoch_source_basis
    (partition_no,job_id,job_epoch,effect_key,source_route,source_id,owner_id,
     ready_generation,ready_basis,working_generation,working_basis)
  SELECT i.partition_no,i.job_id,i.job_epoch,i.effect_key,i.source_route,i.source_id,i.owner_id,
         ready_generation,ready_basis,working_generation,working_basis
  FROM prior CROSS JOIN input i
  RETURNING ready_generation,working_generation
), invalidated AS (
  UPDATE library.canonical_source_state s
  SET ready_generation=NULL,ready_basis=NULL,working_generation=NULL,working_basis=NULL,
      after_subject_id=NULL,after_driver=NULL,after_fact_id=NULL,
      pending_mapping=true,source_exhausted=false
  FROM input i
  WHERE s.route=i.source_route AND s.collection_id=i.source_id AND EXISTS(SELECT 1 FROM retained)
  RETURNING s.collection_id
)
SELECT ready_generation::text,working_generation::text FROM retained
WHERE EXISTS(SELECT 1 FROM invalidated);
