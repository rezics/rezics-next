-- Positive evidence only: empty indexed roots do not prove all-role/custody closure.
-- One typed input feeds one fixed projection of owner-prefix existence probes.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
),
probe AS (
  SELECT
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
    EXISTS (SELECT 1 FROM library.shelf_count WHERE route = input.route AND account_id = input.account_id) AS shelf_count,
    EXISTS (SELECT 1 FROM library.shelf_type_node WHERE route = input.route AND account_id = input.account_id) AS shelf_type_node,
    EXISTS (SELECT 1 FROM library.shelf_type_reservation WHERE route = input.route AND account_id = input.account_id) AS shelf_type_reservation,
    EXISTS (SELECT 1 FROM library.shelf_type_root WHERE route = input.route AND account_id = input.account_id) AS shelf_type_root,
    EXISTS (SELECT 1 FROM library.shelf_type_value WHERE route = input.route AND account_id = input.account_id) AS shelf_type_value,
    EXISTS (SELECT 1 FROM library.type_preparation_header WHERE route = input.route AND account_id = input.account_id) AS type_preparation_header,
    EXISTS (SELECT 1 FROM library.type_preparation_progress WHERE route = input.route AND account_id = input.account_id) AS type_preparation_progress,
    EXISTS (SELECT 1 FROM library.type_preparation_slot WHERE route = input.route AND account_id = input.account_id) AS type_preparation_slot
  FROM input
)
SELECT stores.store
FROM probe
CROSS JOIN LATERAL (VALUES
  (builtin_collection_reference, 'builtin_collection_reference'::text),
  (builtin_state_reference_source, 'builtin_state_reference_source'::text),
  (collection, 'collection'::text),
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
