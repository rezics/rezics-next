INSERT INTO semantic.identity_public_output_subject_slot
(partition_no,capture_partition,capture_id,original,generation,terminal,released)
VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING;
