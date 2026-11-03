-- Positive evidence only: empty indexed roots do not prove all-role/custody closure.
-- One typed input feeds one fixed projection of owner-prefix existence probes.
-- Capture presence keeps the whole FK-owned receipt/hold family pending, even for an unfinished capture.
-- These family obligations are not independent positive child-row observations; capture absence plus the
-- non-cascading FKs proves their local absence. The owner operation rereads actual children before disposition.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
),
probe AS (
  SELECT
    EXISTS (SELECT 1 FROM library.bangumi_upload WHERE route=input.route AND account_id=input.account_id) AS bangumi_upload,
    EXISTS (SELECT 1 FROM library.collection_archive_recovery WHERE route=input.route AND account_id=input.account_id)
      OR EXISTS (SELECT 1 FROM library.collection_archive_recovery_record WHERE route=input.route AND account_id=input.account_id)
      AS collection_archive_recovery,
    EXISTS (SELECT 1 FROM library.collection_publication_operation WHERE route=input.route AND owner_account_id=input.account_id) AS collection_publication_operation,
    EXISTS (SELECT 1 FROM library.collection_source_output WHERE route=input.route AND account_id=input.account_id) AS collection_source_output,
    EXISTS (SELECT 1 FROM library.collection_source_output_publication WHERE route=input.route AND account_id=input.account_id) AS collection_source_output_publication,
    EXISTS (SELECT 1 FROM library.native_source_fence WHERE route = input.route AND account_id = input.account_id)
      OR EXISTS (SELECT 1 FROM library.native_source_fence WHERE route = input.route AND kind = 'account' AND owner_id = input.account_id) AS native_source_fence,
    EXISTS (SELECT 1 FROM library.native_source_capture WHERE route = input.route AND account_id = input.account_id) AS native_source_capture,
    EXISTS (SELECT 1 FROM library.collection_kind_retired WHERE route=input.route AND account_id=input.account_id) AS collection_kind_retired,
    EXISTS (SELECT 1 FROM library.collection_kind_observation WHERE route=input.route AND account_id=input.account_id) AS collection_kind_observation,
    EXISTS (SELECT 1 FROM library.collection_kind_count WHERE route=input.route AND account_id=input.account_id) AS collection_kind_count,
    EXISTS (SELECT 1 FROM library.collection_kind_subject WHERE route=input.route AND account_id=input.account_id) AS collection_kind_subject,
    EXISTS (SELECT 1 FROM library.collection_kind_consent_consumer WHERE route=input.route AND owner_account_id=input.account_id) AS collection_kind_consent_consumer,
    EXISTS (SELECT 1 FROM library.identity_epoch_participant_work WHERE partition_no = (input.route >> 4) AND owner_id = input.account_id) AS identity_epoch_participant_work,
    EXISTS (SELECT 1 FROM library.identity_epoch_source_basis WHERE partition_no = (input.route >> 4) AND owner_id = input.account_id) AS identity_epoch_source_basis,
    EXISTS (SELECT 1 FROM library.owner_identity_scope WHERE partition_no = (input.route >> 4) AND owner_id = input.account_id) AS owner_identity_scope,
    EXISTS (SELECT 1 FROM library.builtin_collection_reference WHERE route = input.route AND account_id = input.account_id) AS builtin_collection_reference,
    EXISTS (SELECT 1 FROM library.builtin_state_reference_source WHERE route = input.route AND account_id = input.account_id) AS builtin_state_reference_source,
    EXISTS (SELECT 1 FROM library.collection WHERE route = input.route AND curator_account_id = input.account_id) AS collection,
    EXISTS (SELECT 1 FROM library.copy WHERE route = input.route AND account_id = input.account_id) AS copy,
    EXISTS (SELECT 1 FROM library.entry WHERE route = input.route AND account_id = input.account_id) AS entry,
    EXISTS (SELECT 1 FROM library.entry_deleted WHERE route = input.route AND account_id = input.account_id) AS entry_deleted,
    EXISTS (SELECT 1 FROM library.fact_source_head WHERE route = input.route AND account_id = input.account_id) AS fact_source_head,
    EXISTS (SELECT 1 FROM library.follow WHERE route = input.route AND account_id = input.account_id) AS follow,
    EXISTS (SELECT 1 FROM library.label_assignment WHERE route = input.route AND account_id = input.account_id) AS label_assignment,
    EXISTS (SELECT 1 FROM library.owner_write_counter WHERE route = input.route AND account_id = input.account_id) AS owner_write_counter,
    EXISTS (SELECT 1 FROM library.personal_label WHERE route = input.route AND account_id = input.account_id) AS personal_label,
    EXISTS (SELECT 1 FROM library.progress_head WHERE route = input.route AND account_id = input.account_id) AS progress_head,
    EXISTS (SELECT 1 FROM library.progress_session WHERE route = input.route AND account_id = input.account_id) AS progress_session,
    EXISTS (SELECT 1 FROM library.published_log WHERE route = input.route AND account_id = input.account_id) AS published_log,
    EXISTS (SELECT 1 FROM library.shelf_writer_owner WHERE route = input.route AND account_id = input.account_id) AS shelf_writer_owner,
    EXISTS (SELECT 1 FROM library.shelf_count WHERE route = input.route AND account_id = input.account_id) AS shelf_count,
    EXISTS (SELECT 1 FROM library.shelf_type_node WHERE route = input.route AND account_id = input.account_id) AS shelf_type_node,
    EXISTS (SELECT 1 FROM library.shelf_type_reservation WHERE route = input.route AND account_id = input.account_id) AS shelf_type_reservation,
    EXISTS (SELECT 1 FROM library.shelf_type_root WHERE route = input.route AND account_id = input.account_id) AS shelf_type_root,
    EXISTS (SELECT 1 FROM library.shelf_type_value WHERE route = input.route AND account_id = input.account_id) AS shelf_type_value,
    EXISTS (SELECT 1 FROM library.type_preparation_header WHERE route = input.route AND account_id = input.account_id) AS type_preparation_header,
    EXISTS (SELECT 1 FROM library.type_preparation_progress WHERE route = input.route AND account_id = input.account_id) AS type_preparation_progress,
    EXISTS (SELECT 1 FROM library.type_preparation_slot WHERE route = input.route AND account_id = input.account_id) AS type_preparation_slot
    ,EXISTS (SELECT 1 FROM library.members_preparation_owner WHERE route = input.route AND owner_account_id = input.account_id) AS members_preparation_owner
    ,EXISTS (SELECT 1 FROM library.members_preparation WHERE route = input.route AND owner_account_id = input.account_id) AS members_preparation
    ,EXISTS (SELECT 1 FROM library.members_preparation_result WHERE route = input.route AND owner_account_id = input.account_id) AS members_preparation_result
  FROM input
)
SELECT stores.store
FROM probe
CROSS JOIN LATERAL (VALUES
  (members_preparation_owner, 'members_preparation_owner'::text),
  (members_preparation, 'members_preparation'::text),
  (members_preparation_result, 'members_preparation_result'::text),
  (collection_publication_operation, 'collection_publication_operation'::text),
  (collection_publication_operation, 'collection_publication_source'::text),
  (collection_publication_operation, 'collection_publication_episode'::text),
  (collection_source_output, 'collection_source_output'::text),
  (collection_source_output, 'collection_source_output_head'::text),
  (collection_source_output, 'collection_source_output_member'::text),
  (collection_source_output, 'collection_publication_staging'::text),
  (collection_source_output, 'collection_publication_staging_evidence'::text),
  (collection_source_output, 'collection_publication_staging_seal'::text),
  (collection_source_output_publication, 'collection_source_output_publication'::text),
  (native_source_capture, 'native_source_capture'::text),
  (native_source_capture, 'native_source_receipt'::text),
  (native_source_capture, 'native_source_hold'::text),
  (native_source_fence, 'native_source_fence'::text),
  (collection_kind_retired, 'collection_kind_retired'::text),
  (collection_kind_observation, 'collection_kind_observation'::text),
  (collection_kind_count, 'collection_kind_count'::text),
  (collection_kind_subject, 'collection_kind_subject'::text),
  (collection_kind_consent_consumer, 'collection_kind_consent_consumer'::text),
  (identity_epoch_participant_work, 'identity_epoch_participant_work'::text),
  (identity_epoch_source_basis, 'identity_epoch_source_basis'::text),
  (owner_identity_scope, 'owner_identity_scope'::text),
  (builtin_collection_reference, 'builtin_collection_reference'::text),
  (builtin_state_reference_source, 'builtin_state_reference_source'::text),
  (collection, 'collection'::text),
  (bangumi_upload, 'bangumi_upload'::text),
  (collection_archive_recovery, 'collection_archive_recovery'::text),
  (copy, 'copy'::text),
  (entry, 'entry'::text),
  (entry_deleted, 'entry_deleted'::text),
  (fact_source_head, 'fact_source_head'::text),
  (follow, 'follow'::text),
  (label_assignment, 'label_assignment'::text),
  (owner_write_counter, 'owner_write_counter'::text),
  (personal_label, 'personal_label'::text),
  (progress_head, 'progress_head'::text),
  (progress_session, 'progress_session'::text),
  (published_log, 'published_log'::text),
  (shelf_writer_owner, 'shelf_writer_owner'::text),
  (shelf_count, 'shelf_count'::text),
  (shelf_type_node, 'shelf_type_node'::text),
  (shelf_type_reservation, 'shelf_type_reservation'::text),
  (shelf_type_root, 'shelf_type_root'::text),
  (shelf_type_value, 'shelf_type_value'::text),
  (type_preparation_header, 'type_preparation_header'::text),
  (type_preparation_progress, 'type_preparation_progress'::text),
  (type_preparation_slot, 'type_preparation_slot'::text)
) AS stores(found, store)
WHERE stores.found;
