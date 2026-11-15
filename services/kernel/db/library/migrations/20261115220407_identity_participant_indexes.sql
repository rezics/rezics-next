-- migrate:up
CREATE INDEX identity_epoch_participant_follow_pending ON library.identity_epoch_participant_work
  (partition_no,job_id,job_epoch,effect_key) WHERE NOT follow_complete;
CREATE INDEX collection_member_identity_original ON library.collection_member
  (route,subject_id,collection_id) WHERE deletion_id IS NULL;
CREATE INDEX collection_source_output_member_identity_original ON library.collection_source_output_member
  (route,subject_id,collection_id,generation);

-- migrate:down
DROP INDEX library.collection_source_output_member_identity_original;
DROP INDEX library.collection_member_identity_original;
DROP INDEX library.identity_epoch_participant_follow_pending;
