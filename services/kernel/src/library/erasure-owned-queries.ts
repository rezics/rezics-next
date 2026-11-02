import purgeMembersPreparation from './erasure-owned-members-preparation.sql';
import purgeMembersPreparationResult from './erasure-owned-members-preparation-result.sql';
import purgeMembersPreparationOwner from './erasure-owned-members-preparation-owner.sql';
import purgeCollectionKindRetired from './collection-kind-erase-retired.sql';
import purgeCollectionKindObservation from './collection-kind-erase-observation.sql';
import purgeCollectionKindCount from './collection-kind-erase-count.sql';
import purgeCollectionKindSubject from './collection-kind-erase-subject.sql';
import purgeCollectionKindConsentConsumer from './collection-kind-consent-erase-consumer.sql';
import purgeOwnerIndexLabelRepair from './erasure-owned-owner-index-label-repair.sql';
import purgeOwnerIndexState from './erasure-owned-owner-index-state.sql';
import purgeOwnerMemberSupport from './erasure-owned-owner-member-support.sql';
import purgeOwnerMemberIndex from './erasure-owned-owner-member-index.sql';
import purgeOwnerIndexPin from './erasure-owned-owner-index-pin.sql';
import purgeOwnerIndexControl from './erasure-owned-owner-index-control.sql';
import purgeEntryDeleted from './erasure-owned-entry-deleted.sql';
import purgeLabelAssignment from './erasure-owned-label-assignment.sql';
import purgePersonalLabel from './erasure-owned-personal-label.sql';
import purgeProgressHead from './erasure-owned-progress-head.sql';
import purgePublishedLog from './erasure-owned-published-log.sql';
import purgeCollectionPins from './erasure-owned-collection-pins.sql';
import purgeBuiltinStateReferenceSource from './erasure-owned-builtin-state-reference-source.sql';
import purgeBuiltinCollectionReference from './erasure-owned-builtin-collection-reference.sql';
import purgeShelfWriterOwner from './erasure-owned-shelf-writer-owner.sql';
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
export const ownedQueries: {
  readonly members_preparation_result: typeof purgeMembersPreparationResult;
  readonly members_preparation: typeof purgeMembersPreparation;
  readonly members_preparation_owner: typeof purgeMembersPreparationOwner;
  readonly collection_kind_retired: typeof purgeCollectionKindRetired;
  readonly collection_kind_observation: typeof purgeCollectionKindObservation;
  readonly collection_kind_count: typeof purgeCollectionKindCount;
  readonly collection_kind_subject: typeof purgeCollectionKindSubject;
  readonly collection_kind_consent_consumer: typeof purgeCollectionKindConsentConsumer;
  readonly owner_index_label_repair: typeof purgeOwnerIndexLabelRepair;
  readonly owner_index_state: typeof purgeOwnerIndexState;
  readonly owner_member_support: typeof purgeOwnerMemberSupport;
  readonly owner_member_index: typeof purgeOwnerMemberIndex;
  readonly owner_index_pin: typeof purgeOwnerIndexPin;
  readonly owner_index_control: typeof purgeOwnerIndexControl;
  readonly entry_deleted: typeof purgeEntryDeleted;
  readonly label_assignment: typeof purgeLabelAssignment;
  readonly personal_label: typeof purgePersonalLabel;
  readonly progress_head: typeof purgeProgressHead;
  readonly published_log: typeof purgePublishedLog;
  readonly collection_pins: typeof purgeCollectionPins;
  readonly builtin_state_reference_source: typeof purgeBuiltinStateReferenceSource;
  readonly builtin_collection_reference: typeof purgeBuiltinCollectionReference;
  readonly shelf_writer_owner: typeof purgeShelfWriterOwner;
  readonly shelf_count: typeof purgeShelfCount;
  readonly shelf_type_node: typeof purgeShelfTypeNode;
  readonly shelf_type_reservation: typeof purgeShelfTypeReservation;
  readonly shelf_type_root: typeof purgeShelfTypeRoot;
  readonly shelf_type_value: typeof purgeShelfTypeValue;
  readonly owner_write_counter: typeof purgeOwnerWriteCounter;
  readonly fact_source_head: typeof purgeFactSourceHead;
  readonly type_preparation_slot: typeof purgeTypePreparationSlot;
  readonly type_preparation_progress: typeof purgeTypePreparationProgress;
  readonly type_preparation_header: typeof purgeTypePreparationHeader;
  readonly bulk_target: typeof purgeBulkTarget;
} = {
  members_preparation_result: purgeMembersPreparationResult,
  members_preparation: purgeMembersPreparation,
  members_preparation_owner: purgeMembersPreparationOwner,
  collection_kind_retired: purgeCollectionKindRetired,
  collection_kind_observation: purgeCollectionKindObservation,
  collection_kind_count: purgeCollectionKindCount,
  collection_kind_subject: purgeCollectionKindSubject,
  collection_kind_consent_consumer: purgeCollectionKindConsentConsumer,
  owner_index_label_repair: purgeOwnerIndexLabelRepair,
  owner_index_state: purgeOwnerIndexState,
  owner_member_support: purgeOwnerMemberSupport,
  owner_member_index: purgeOwnerMemberIndex,
  owner_index_pin: purgeOwnerIndexPin,
  owner_index_control: purgeOwnerIndexControl,

  entry_deleted: purgeEntryDeleted,
  label_assignment: purgeLabelAssignment,
  personal_label: purgePersonalLabel,
  progress_head: purgeProgressHead,
  published_log: purgePublishedLog,
  collection_pins: purgeCollectionPins,
  builtin_state_reference_source: purgeBuiltinStateReferenceSource,
  builtin_collection_reference: purgeBuiltinCollectionReference,
  shelf_writer_owner: purgeShelfWriterOwner,
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
