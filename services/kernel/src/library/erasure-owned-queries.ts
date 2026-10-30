import purgeEntryDeleted from './erasure-owned-entry-deleted.sql';
import purgeLabelAssignment from './erasure-owned-label-assignment.sql';
import purgePersonalLabel from './erasure-owned-personal-label.sql';
import purgeProgressHead from './erasure-owned-progress-head.sql';
import purgePublishedLog from './erasure-owned-published-log.sql';
import purgeCollectionPins from './erasure-owned-collection-pins.sql';
import purgeBuiltinStateReferenceSource from './erasure-owned-builtin-state-reference-source.sql';
import purgeBuiltinCollectionReference from './erasure-owned-builtin-collection-reference.sql';
import purgeShelfCount from './erasure-owned-shelf-count.sql';
import purgeShelfTypeNode from './erasure-owned-shelf-type-node.sql';
import purgeShelfTypeReservation from './erasure-owned-shelf-type-reservation.sql';
import purgeShelfTypeRoot from './erasure-owned-shelf-type-root.sql';
import purgeShelfTypeValue from './erasure-owned-shelf-type-value.sql';
import purgeOwnerWriteCounter from './erasure-owned-owner-write-counter.sql';
import purgeFactSourceHead from './erasure-owned-fact-source-head.sql';
import purgeTypePreparationSlot from './erasure-owned-type-preparation-slot.sql';
import purgeTypePreparationProgress from './erasure-owned-type-preparation-progress.sql';
import purgeTypePreparationHeader from './erasure-owned-type-preparation-header.sql';
import purgeBulkTarget from './erasure-owned-bulk-target.sql';

/** Fixed producer inventory, in child-before-parent order; heads are last. */
export const ownedQueries = {
  entry_deleted: purgeEntryDeleted,
  label_assignment: purgeLabelAssignment,
  personal_label: purgePersonalLabel,
  progress_head: purgeProgressHead,
  published_log: purgePublishedLog,
  collection_pins: purgeCollectionPins,
  builtin_state_reference_source: purgeBuiltinStateReferenceSource,
  builtin_collection_reference: purgeBuiltinCollectionReference,
  shelf_count: purgeShelfCount,
  shelf_type_node: purgeShelfTypeNode,
  shelf_type_reservation: purgeShelfTypeReservation,
  shelf_type_root: purgeShelfTypeRoot,
  shelf_type_value: purgeShelfTypeValue,
  owner_write_counter: purgeOwnerWriteCounter,
  fact_source_head: purgeFactSourceHead,
  type_preparation_slot: purgeTypePreparationSlot,
  type_preparation_progress: purgeTypePreparationProgress,
  type_preparation_header: purgeTypePreparationHeader,
  bulk_target: purgeBulkTarget,
} as const;
