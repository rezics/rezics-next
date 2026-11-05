WITH parameters AS (SELECT $1::integer home,$2::uuid job,$3::jsonb sources), input AS (
 SELECT * FROM jsonb_to_recordset((SELECT sources FROM parameters)) AS r(input_original uuid,source_route integer,
 partition_no integer,terminal uuid,generation uuid,version bigint,observed_count bigint,source_revision bigint,
 source_transaction_id uuid,owner_epoch integer,source_owner_epoch integer)
), refs AS (
 INSERT INTO semantic.identity_epoch_input(partition_no,job_id,terminal,generation,basis_version,original_count,control_partition,owner_epoch)
 SELECT DISTINCT (SELECT home FROM parameters),(SELECT job FROM parameters),terminal,generation,version,observed_count,partition_no,owner_epoch FROM input
), plans AS (
 INSERT INTO semantic.identity_epoch_admission_plan(partition_no,job_id,resource_home)
 SELECT DISTINCT (SELECT home FROM parameters),(SELECT job FROM parameters),partition_no FROM input
)
INSERT INTO semantic.identity_epoch_admission_source(partition_no,job_id,original,route,control_partition,terminal,generation,
 basis_version,source_revision,source_transaction_id,owner_epoch,source_owner_epoch)
SELECT (SELECT home FROM parameters),(SELECT job FROM parameters),input_original,source_route,partition_no,terminal,generation,
 version,source_revision,source_transaction_id,owner_epoch,source_owner_epoch FROM input;
