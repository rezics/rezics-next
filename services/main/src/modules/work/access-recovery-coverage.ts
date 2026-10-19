import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { canonicalRowText, foldRowCoverage, ownerCatalog, scanOwnerTable,
  type OwnerCatalog, type OwnerTable, type RowCoverage } from './pg-recovery-frontier.ts';

export type AccessRecoveryProfile = 'access-state-v5' | 'access-authority-v6';

export interface AccessLeaseEpochs { derivedGeneration: string; discoveryRefresh: string }

export function restoredAccessLeaseEpochs(base: AccessLeaseEpochs | undefined,
  retained: AccessLeaseEpochs | undefined): AccessLeaseEpochs {
  const max = (key: keyof AccessLeaseEpochs) => {
    const before = BigInt(base?.[key] ?? '0'), current = BigInt(retained?.[key] ?? '0');
    return (before > current ? before : current).toString();
  };
  return { derivedGeneration: max('derivedGeneration'), discoveryRefresh: max('discoveryRefresh') };
}

export type AccessRecoveryClass = 'authority' | 'derived-projection' | 'operational';
interface AccessRecoveryRule {
  class: AccessRecoveryClass;
  columns?: Readonly<Record<string, AccessRecoveryClass>>;
  generationColumn?: string;
  generationPayload?: boolean;
  authorityWhere?: string;
  rebuild?: string;
  leaseFloor?: keyof AccessLeaseEpochs;
  operationalWhen?: { column: string; value: string };
  writer?: string;
  writerKind?: string;
  reason?: string;
  reset?: string;
}

/**
 * Recovery preserves durable decisions, delivery evidence and replay identities.
 * Mutable projections and worker progress are excluded from comparison, but kept from the backup.
 * Only the named epoch-bound caches and build lease state are reset.
 * Keep this inventory explicit: admitting a new table requires a recovery decision.
 */
export const ACCESS_RECOVERY_CLASSIFICATION: Readonly<Record<string, AccessRecoveryRule>> = {
  'access.account_deletion_classification_frontier': { class: 'authority',
    writer: 'services/main/src/modules/access/account-deletion-agents.ts; services/main/migrations/access/2042_account_deletion_classification_frontier.sql',
    writerKind: 'account deletion command and controller-change trigger',
    reason: 'Pending reclassification is part of the retained account deletion cut and must stay exact with its progress rows.' },
  'access.account_deletion_orphan_agent': { class: 'authority',
    writer: 'services/main/src/modules/access/account-deletion-agents.ts', writerKind: 'authority command or durable replay evidence' },
  'access.account_deletion_progress': { class: 'authority',
    writer: 'services/main/src/modules/access/account-deletion-agents.ts', writerKind: 'authority command or durable replay evidence' },
  'access.account_deletion_progress_agent': { class: 'authority',
    writer: 'services/main/src/modules/access/account-deletion-agents.ts', writerKind: 'authority command or durable replay evidence' },
  'access.acting_context_preference': { class: 'authority',
    writer: 'services/main/src/modules/access/contexts.ts', writerKind: 'authority command or durable replay evidence' },
  'access.acting_context_preference_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/contexts.ts', writerKind: 'authority command or durable replay evidence' },
  'access.admission': { class: 'authority',
    writer: 'services/main/src/modules/access/admission.ts; services/main/src/modules/access/organization-moderation.ts; services/main/src/modules/access/topology.ts; services/main/src/modules/proposal/access.ts; services/main/src/modules/statement/upgrade.ts; services/main/src/modules/vote/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.admission_obligation': { class: 'authority',
    writer: 'services/main/src/modules/access/represented-work-proof.ts; services/main/src/modules/access/topology.ts', writerKind: 'authority command or durable replay evidence' },
  'access.admission_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/admission.ts; services/main/src/modules/access/organization-moderation.ts; services/main/src/modules/proposal/access.ts; services/main/src/modules/vote/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.admitted_type': { class: 'authority',
    writer: 'services/main/src/modules/types/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.agent_control': { class: 'authority',
    writer: 'services/main/src/modules/access/agent-control.ts', writerKind: 'authority command or durable replay evidence' },
  'access.agent_invitation': { class: 'authority',
    writer: 'services/main/src/modules/access/invitation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.agent_invitation_acceptance': { class: 'authority',
    writer: 'services/main/src/modules/access/invitation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.agent_invitation_revocation': { class: 'authority',
    writer: 'services/main/src/modules/access/invitation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.agent_library_visibility': { class: 'authority',
    writer: 'services/main/src/modules/profiles/visibility.ts', writerKind: 'authority command or durable replay evidence' },
  'access.agent_library_visibility_receipt': { class: 'authority',
    writer: 'services/main/src/modules/profiles/visibility.ts', writerKind: 'authority command or durable replay evidence' },
  'access.agent_listing': { class: 'authority',
    writer: 'services/main/src/modules/profiles/listing.ts', writerKind: 'authority command or durable replay evidence' },
  'access.agent_listing_receipt': { class: 'authority',
    writer: 'services/main/src/modules/profiles/listing.ts', writerKind: 'authority command or durable replay evidence' },
  'access.agent_provision': { class: 'authority',
    writer: 'services/main/src/modules/agent/provision.ts', writerKind: 'authority command or durable replay evidence' },
  'access.agent_recovery': { class: 'authority',
    writer: 'services/main/src/modules/access/agent-control.ts', writerKind: 'authority command or durable replay evidence' },
  'access.alias_graph_import': { class: 'authority',
    writer: 'services/main/src/modules/address/migrate.ts', writerKind: 'authority command or durable replay evidence' },
  'access.alias_graph_import_report': { class: 'authority',
    writer: 'services/main/src/modules/address/migrate.ts', writerKind: 'authority command or durable replay evidence' },
  'access.alias_history': { class: 'authority',
    writer: 'services/main/src/modules/address/migrate.ts; services/main/src/modules/address/registry.ts', writerKind: 'authority command or durable replay evidence' },
  'access.alias_receipt': { class: 'authority',
    writer: 'services/main/src/modules/address/registry.ts; services/main/migrations/access/1029_alias_vocabulary.sql', writerKind: 'authority command or durable replay evidence' },
  'access.alias_registry': { class: 'authority',
    writer: 'services/main/src/modules/address/migrate.ts; services/main/src/modules/address/registry.ts', writerKind: 'authority command or durable replay evidence' },
  'access.alias_reserved_word': { class: 'authority',
    writer: 'services/main/src/modules/address/registry.ts; services/main/migrations/access/1029_alias_vocabulary.sql', writerKind: 'authority command or durable replay evidence' },
  'access.also_enjoyed_generation': { class: 'authority',
    writer: 'services/main/src/modules/also-enjoyed/store.ts; services/main/migrations/access/1160_source_fence_change_log.sql; services/main/migrations/access/1200_also_enjoyed_refresh.sql; services/main/migrations/access/785_also_enjoyed_generation.sql', writerKind: 'immutable generation identity with mutable build progress',
    generationColumn: 'generation_id',
    reason: 'Identity and closed evidence remain exact; building progress is excluded and kept from the backup.',
    columns: {
      access_revision: 'authority',
      after_key: 'operational',
      content_revision: 'authority',
      family: 'authority',
      generation_id: 'authority',
      graph_epoch: 'authority',
      graph_sequence: 'authority',
      pair_count: 'operational',
      phase: 'operational',
      signal_count: 'operational',
    },
  },
  'access.also_enjoyed_pair': { class: 'operational',
    generationColumn: 'generation_id', generationPayload: true,
    writer: 'services/main/src/modules/also-enjoyed/store.ts; services/main/migrations/access/1160_source_fence_change_log.sql; services/main/migrations/access/1200_also_enjoyed_refresh.sql; services/main/migrations/access/785_also_enjoyed_generation.sql', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.also_enjoyed_signal': { class: 'operational',
    generationColumn: 'generation_id', generationPayload: true,
    writer: 'services/main/src/modules/also-enjoyed/store.ts; services/main/migrations/access/1160_source_fence_change_log.sql; services/main/migrations/access/1200_also_enjoyed_refresh.sql; services/main/migrations/access/785_also_enjoyed_generation.sql', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.also_enjoyed_source_change': { class: 'derived-projection',
    writer: 'services/main/src/modules/also-enjoyed/store.ts; services/main/src/modules/owner/restore-release-binding.ts; services/main/migrations/access/1160_source_fence_change_log.sql; services/main/migrations/access/1200_also_enjoyed_refresh.sql', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.also_enjoyed_source_fence': { class: 'derived-projection',
    writer: 'services/main/src/modules/also-enjoyed/store.ts; services/main/migrations/access/1160_source_fence_change_log.sql; services/main/migrations/access/1200_also_enjoyed_refresh.sql; services/main/migrations/access/785_also_enjoyed_generation.sql', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.authority_control_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/topology-control.ts', writerKind: 'authority command or durable replay evidence' },
  'access.authority_subject': { class: 'authority',
    writer: 'services/main/src/modules/access/account-deletion-agents.ts; services/main/src/modules/access/fixture-authority-scenario.ts; services/main/src/modules/access/realm-initialization.ts; services/main/src/modules/agent/provision.ts', writerKind: 'authority command or durable replay evidence' },
  'access.automation_enrollment': { class: 'authority',
    writer: 'services/main/src/modules/access/protected-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.automation_installation': { class: 'authority',
    writer: 'services/main/src/modules/access/protected-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.baseline_admission': { class: 'authority',
    writer: 'services/main/src/modules/access/baseline.ts', writerKind: 'authority command or durable replay evidence' },
  'access.baseline_member_policy': { class: 'authority',
    writer: 'services/main/src/modules/access/baseline.ts; services/main/src/modules/preferences/store.ts; services/main/src/modules/studio/access.ts; services/main/src/modules/work/maintainer-proof.ts; services/main/migrations/access/350_baseline_member.sql', writerKind: 'authority command or durable replay evidence' },
  'access.chapter_notification_event': { class: 'authority',
    writer: 'services/main/src/modules/feed/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.command_custody': { class: 'authority',
    writer: 'services/main/src/modules/outbox/receipt-custody.ts', writerKind: 'authority command or durable replay evidence' },
  'access.context_selection': { class: 'authority',
    writer: 'services/main/src/modules/context/private-selection.ts', writerKind: 'authority command or durable replay evidence' },
  'access.context_selection_receipt': { class: 'authority',
    writer: 'services/main/src/modules/context/private-selection.ts', writerKind: 'authority command or durable replay evidence' },
  'access.context_selection_revision': { class: 'authority',
    writer: 'services/main/src/modules/context/private-selection.ts', writerKind: 'authority command or durable replay evidence' },
  'access.decision_snapshot': { class: 'authority',
    writer: 'services/main/src/modules/access/decision-snapshot-store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.decision_snapshot_input': { class: 'authority',
    writer: 'services/main/src/modules/access/decision-snapshot-store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.derived_generation_activation': { class: 'authority',
    writer: 'services/main/src/modules/recommendation/derived-generation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.derived_generation_family': { class: 'authority',
    writer: 'services/main/src/modules/also-enjoyed/store.ts; services/main/src/modules/recommendation/derived-generation.ts; services/main/migrations/access/110_derived_generation.sql; services/main/migrations/access/315_discovery_projection.sql; services/main/migrations/access/785_also_enjoyed_generation.sql', writerKind: 'authority command or durable replay evidence' },
  'access.derived_generation_head': { class: 'authority',
    writer: 'services/main/src/modules/recommendation/derived-generation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.derived_generation_input': { class: 'authority',
    writer: 'services/main/src/modules/also-enjoyed/store.ts; services/main/src/modules/discovery/refresh-store.ts; services/main/src/modules/discovery/store.ts; services/main/src/modules/recommendation/ranking.ts', writerKind: 'immutable generation identity with mutable build progress',
    generationColumn: 'generation_id',
    reason: 'Identity and closed evidence remain exact; building progress is excluded and kept from the backup.',
    columns: {
      checkpoint_event: 'operational',
      checkpoint_sequence: 'operational',
      data_epoch: 'authority',
      generation_id: 'authority',
      pinned_sequence: 'authority',
      recovery_data_epoch: 'operational',
      snapshot_complete: 'operational',
      snapshot_cursor: 'operational',
      source: 'authority',
    },
  },
  'access.derived_generation_receipt': { class: 'authority',
    writer: 'services/main/src/modules/recommendation/derived-generation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.discovery_concept_count': { class: 'operational',
    generationColumn: 'generation_id', generationPayload: true,
    writer: 'services/main/src/modules/discovery/store.ts; services/main/src/modules/discovery/refresh-store.ts (dynamic payload tables); services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.discovery_coverage': { class: 'operational',
    generationColumn: 'generation_id', generationPayload: true,
    writer: 'services/main/src/modules/discovery/refresh-store.ts; services/main/src/modules/discovery/store.ts', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.discovery_entry': { class: 'operational',
    generationColumn: 'generation_id', generationPayload: true,
    writer: 'services/main/src/modules/discovery/store.ts; services/main/src/modules/discovery/versions.ts', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.discovery_generation': { class: 'authority',
    writer: 'services/main/src/modules/discovery/refresh-store.ts; services/main/src/modules/discovery/store.ts', writerKind: 'immutable generation identity with mutable build progress',
    generationColumn: 'generation_id',
    reason: 'Identity and closed evidence remain exact; building progress is excluded and kept from the backup.',
    columns: {
      access_revision: 'authority',
      catchup_works: 'operational',
      changed_works: 'operational',
      checkpoint: 'operational',
      complete: 'operational',
      context: 'authority',
      family: 'authority',
      generation_id: 'authority',
      principal_id: 'authority',
      realm: 'authority',
      rebuild_pending: 'operational',
      recovery_generation: 'authority',
      scope: 'authority',
      source_epoch: 'authority',
      source_sequence: 'operational',
      storage_generation: 'operational',
      storage_version: 'operational',
      work_count: 'operational',
    },
  },
  'access.discovery_refresh': { class: 'operational',
    writer: 'services/main/src/modules/discovery/refresh-store.ts', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
    leaseFloor: 'discoveryRefresh',
    // Preserve the backup schedule and attached generation, but never reuse a
    // lease held before either authenticated cut when Access reopens.
    reset: 'UPDATE access.discovery_refresh SET lease_epoch = greatest(lease_epoch, $1::bigint) + 1',
    rebuild: 'DiscoveryRefreshStore.claim (services/main/src/modules/discovery/refresh-store.ts)',
  },
  'access.discovery_refresh_catalog': { class: 'operational',
    writer: 'services/main/src/modules/discovery/refresh-store.ts', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.discovery_retirement': { class: 'operational',
    writer: 'services/main/src/modules/discovery/refresh-store.ts', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.discovery_source_change': { class: 'derived-projection',
    writer: 'services/main/src/modules/discovery/store.ts; services/main/src/modules/owner/restore-release-binding.ts; services/main/migrations/access/1160_source_fence_change_log.sql; services/main/migrations/access/1180_discovery_source_keys.sql', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.discovery_source_fence': { class: 'derived-projection',
    writer: 'services/main/src/modules/discovery/store.ts; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1060_discovery_rating_repairs.sql; services/main/migrations/access/1160_source_fence_change_log.sql; services/main/migrations/access/1180_discovery_source_keys.sql; services/main/migrations/access/315_discovery_projection.sql', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.discovery_source_key': { class: 'derived-projection',
    writer: 'services/main/src/modules/discovery/store.ts; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1060_discovery_rating_repairs.sql; services/main/migrations/access/1160_source_fence_change_log.sql; services/main/migrations/access/1180_discovery_source_keys.sql; services/main/migrations/access/315_discovery_projection.sql', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.discovery_term_count': { class: 'operational',
    generationColumn: 'generation_id', generationPayload: true,
    writer: 'services/main/src/modules/discovery/store.ts; services/main/src/modules/discovery/refresh-store.ts (dynamic payload tables); services/main/src/modules/recommendation/ranking.ts; services/main/migrations/access/1021_discovery_concept_seek.sql; services/main/migrations/access/1023_discovery_topic_membership.sql; services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql; services/main/migrations/access/560_discovery_popular_terms.sql', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.download_read_lease': { class: 'authority',
    writer: 'services/main/src/modules/access/download-leases.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_application': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_application_command': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/command-journal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_application_outcome': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_command_admission': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/admission.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_command_binding': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/command-journal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_command_outcome': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/command-journal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_command_receipt': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_decision': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_event': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_event_clock': { class: 'authority',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_owner_admission': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/admission.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_proposal': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_review': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.editorial_revision': { class: 'authority',
    writer: 'services/main/src/modules/editorial-review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.eligible_org_member_set': { class: 'authority',
    writer: 'services/main/src/modules/access/eligible-org-member-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.eligible_org_member_set_grant': { class: 'authority',
    writer: 'services/main/src/modules/access/eligible-org-member-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.eligible_org_member_set_grant_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/eligible-org-member-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.event_histogram_bucket': { class: 'operational',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.event_interval_key': { class: 'operational',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.event_temporal_applied': { class: 'derived-projection',
    writer: 'services/main/src/modules/event/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.event_temporal_bucket': { class: 'derived-projection',
    writer: 'services/main/src/modules/event/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.event_temporal_checkpoint': { class: 'derived-projection',
    writer: 'services/main/src/modules/event/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.event_temporal_interval': { class: 'derived-projection',
    writer: 'services/main/src/modules/event/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.event_temporal_member': { class: 'derived-projection',
    writer: 'services/main/src/modules/event/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.event_temporal_pending': { class: 'derived-projection',
    writer: 'services/main/src/modules/event/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.event_temporal_window': { class: 'derived-projection',
    writer: 'services/main/src/modules/event/projection.ts; services/main/src/modules/event/queries.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.event_temporal_window_update': { class: 'authority',
    writer: 'services/main/src/modules/event/effects.ts; services/main/src/modules/event/projection.ts', writerKind: 'publication authority command and projection worker',
    reason: 'Durable admission, receipt, digest, expiry and authority-epoch evidence protects publication retries.',
  },
  'access.feed_author_dirty': { class: 'derived-projection',
    writer: 'services/main/src/modules/feed/target-index.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.feed_checkpoint': { class: 'derived-projection',
    writer: 'services/main/src/modules/feed/store.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.feed_item': { class: 'derived-projection',
    writer: 'services/main/src/modules/feed/store.ts; services/main/src/modules/feed/target-index.ts; services/main/src/modules/rankings/realm-threads.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.feed_post_vote_event': { class: 'authority',
    writer: 'services/main/src/modules/feed/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.feed_target': { class: 'derived-projection',
    writer: 'services/main/src/modules/feed/target-index.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.feed_target_checkpoint': { class: 'derived-projection',
    writer: 'services/main/src/modules/feed/target-index.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.feed_vote': { class: 'authority',
    writer: 'services/main/src/modules/feed/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.feed_vote_receipt': { class: 'authority',
    writer: 'services/main/src/modules/feed/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.follow': { class: 'authority',
    writer: 'services/main/src/modules/follows/merge-handler.ts; services/main/src/modules/follows/recovery.ts; services/main/src/modules/follows/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.follow_activity': { class: 'derived-projection',
    writer: 'services/main/src/modules/feed/store.ts; services/main/src/modules/notification-producers/producer.ts', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.follow_inventory': { class: 'authority',
    writer: 'services/main/src/modules/follows/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.follow_merge_receipt': { class: 'authority',
    writer: 'services/main/src/modules/follows/merge-handler.ts', writerKind: 'authority command or durable replay evidence' },
  'access.follow_receipt': { class: 'authority',
    writer: 'services/main/src/modules/follows/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.follow_space_alias': { class: 'authority',
    writer: 'services/main/src/modules/follows/targets.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_case': { class: 'authority',
    writer: 'services/main/src/modules/governance/realm-sanction-appeal.ts; services/main/src/modules/governance/store.ts; services/main/src/modules/public-report/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_case_credential': { class: 'authority',
    writer: 'services/main/src/modules/public-report/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_case_evidence': { class: 'authority',
    writer: 'services/main/src/modules/governance/decision-evidence.ts; services/main/migrations/access/1423_governance_evidence_membership.sql', writerKind: 'authority command or durable replay evidence' },
  'access.governance_correspondence_receipt': { class: 'authority',
    writer: 'services/main/src/modules/public-report/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_enforcement': { class: 'authority',
    writer: 'services/main/src/modules/governance/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_erasure_postponement': { class: 'authority',
    writer: 'services/main/src/modules/public-report/preservation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_evidence': { class: 'authority',
    writer: 'services/main/src/modules/governance/store.ts; services/main/src/modules/public-report/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_preservation_delivery_head': { class: 'authority',
    writer: 'services/main/migrations/access/2040_preservation_delivery_version.sql',
    writerKind: 'preservation hold transaction trigger',
    reason: 'Delivery compares this retained version to refuse a hold that changed between authority checks.' },
  'access.governance_preservation_hold': { class: 'authority',
    writer: 'services/main/src/modules/public-report/store.ts; services/main/src/modules/safety-queue/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_process_step': { class: 'authority',
    writer: 'services/main/src/modules/governance/store.ts; services/main/src/modules/public-report/store.ts; services/main/src/modules/rights/counter-notice-worker.ts; services/main/src/modules/rights/counter-notice.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_report': { class: 'authority',
    writer: 'services/main/src/modules/governance/store.ts; services/main/src/modules/public-report/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_role': { class: 'authority',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'authority command or durable replay evidence' },
  'access.governance_rule_head': { class: 'authority',
    writer: 'services/main/src/modules/governance/rules.ts', writerKind: 'authority command or durable replay evidence' },
  'access.governance_rule_revision': { class: 'authority',
    writer: 'services/main/src/modules/governance/rules.ts', writerKind: 'authority command or durable replay evidence' },
  'access.grant_change_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/grants.ts', writerKind: 'authority command or durable replay evidence' },
  'access.grant_lineage': { class: 'authority',
    writer: 'services/main/src/modules/access/grants.ts; services/main/src/modules/access/invitation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.group_change_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/groups.ts', writerKind: 'authority command or durable replay evidence' },
  'access.group_impact_activation': { class: 'authority',
    writer: 'services/main/src/modules/access/groups.ts', writerKind: 'authority command or durable replay evidence' },
  'access.group_impact_proposal': { class: 'authority',
    writer: 'services/main/src/modules/access/groups.ts', writerKind: 'authority command or durable replay evidence' },
  'access.group_member': { class: 'authority',
    writer: 'services/main/src/modules/access/groups.ts; services/main/src/modules/access/protected-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.group_permission_grant': { class: 'authority',
    writer: 'services/main/src/modules/access/groups.ts', writerKind: 'authority command or durable replay evidence' },
  'access.home_command_receipt': { class: 'authority',
    writer: 'services/main/src/modules/feed/personal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.home_exclusion': { class: 'authority',
    writer: 'services/main/src/modules/feed/personal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.home_state': { class: 'authority',
    writer: 'services/main/src/modules/feed/personal.ts; services/main/src/modules/preferences/languages.ts', writerKind: 'authority command or durable replay evidence' },
  'access.home_watermark': { class: 'authority',
    writer: 'services/main/src/modules/feed/personal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.identity_merge_completion': { class: 'authority',
    writer: 'services/main/src/modules/identity-merge/journal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.identity_merge_item': { class: 'authority',
    writer: 'services/main/src/modules/identity-merge/journal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.identity_merge_item_outcome': { class: 'authority',
    writer: 'services/main/src/modules/identity-merge/journal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.identity_merge_page': { class: 'authority',
    writer: 'services/main/src/modules/identity-merge/journal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.identity_merge_task': { class: 'authority',
    writer: 'services/main/src/modules/identity-merge/journal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.interaction_block': { class: 'authority',
    writer: 'services/main/src/modules/access/interaction-decisions.ts', writerKind: 'authority command or durable replay evidence' },
  'access.interaction_change_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/interaction-decisions.ts', writerKind: 'authority command or durable replay evidence' },
  'access.interaction_mute_preference': { class: 'authority',
    writer: 'services/main/src/modules/access/interaction-decisions.ts', writerKind: 'authority command or durable replay evidence' },
  'access.judgment_aggregate': { class: 'authority',
    writer: 'services/main/src/modules/judgment/access.ts; services/main/src/modules/judgment/badge.ts', writerKind: 'authority command or durable replay evidence' },
  'access.judgment_badge_projection': { class: 'derived-projection',
    writer: 'services/main/src/modules/judgment/badge.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.judgment_concept_hint': { class: 'authority',
    writer: 'services/main/src/modules/judgment/badge.ts; services/main/src/modules/judgment/hint.ts', writerKind: 'authority command or durable replay evidence' },
  'access.judgment_concept_hint_receipt': { class: 'authority',
    writer: 'services/main/src/modules/judgment/hint.ts', writerKind: 'authority command or durable replay evidence' },
  'access.judgment_head': { class: 'authority',
    writer: 'services/main/src/modules/judgment/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.judgment_outbox': { class: 'authority',
    writer: 'services/main/src/modules/judgment/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.judgment_receipt': { class: 'authority',
    writer: 'services/main/src/modules/judgment/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.judgment_revision': { class: 'authority',
    writer: 'services/main/src/modules/judgment/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.library_follow_position': { class: 'operational',
    writer: 'services/main/src/modules/library/follows.ts', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.live_principal_controller': { class: 'authority',
    writer: 'services/main/migrations/access/2042_account_deletion_classification_frontier.sql; services/main/migrations/access/2061_principal_controller_subject_budget.sql',
    writerKind: 'controller mandate trigger and principal deactivation command',
    reason: 'Account deletion uses this live controller cut to decide whether a Person keeps a controller; retain exact authority comparison.' },
  'access.main_agent_preference': { class: 'authority',
    writer: 'services/main/src/modules/access/session-agent.ts; services/main/migrations/access/310_session_agent.sql', writerKind: 'authority command or durable replay evidence' },
  'access.main_agent_preference_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/session-agent.ts; services/main/migrations/access/310_session_agent.sql', writerKind: 'authority command or durable replay evidence' },
  'access.managed_org_grant': { class: 'authority',
    writer: 'services/main/src/modules/access/managed-organizations.ts', writerKind: 'authority command or durable replay evidence' },
  'access.managed_org_grant_event': { class: 'authority',
    writer: 'services/main/src/modules/access/managed-organizations.ts', writerKind: 'authority command or durable replay evidence' },
  'access.managed_org_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/managed-organizations.ts', writerKind: 'authority command or durable replay evidence' },
  'access.membership': { class: 'authority',
    writer: 'services/main/src/modules/access/fixture-authority-scenario.ts; services/main/src/modules/access/memberships.ts; services/main/src/modules/access/realm-management-members.ts; services/main/src/modules/realm-admin/join-requests.ts', writerKind: 'authority command or durable replay evidence' },
  'access.membership_ban': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-management-members.ts', writerKind: 'authority command or durable replay evidence' },
  'access.membership_change_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/memberships.ts', writerKind: 'authority command or durable replay evidence' },
  'access.membership_consent': { class: 'authority',
    writer: 'services/main/src/modules/access/membership-consents.ts', writerKind: 'authority command or durable replay evidence' },
  'access.membership_consent_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/membership-consents.ts', writerKind: 'authority command or durable replay evidence' },
  'access.membership_consent_revocation': { class: 'authority',
    writer: 'services/main/src/modules/access/membership-consents.ts', writerKind: 'authority command or durable replay evidence' },
  'access.membership_consent_use': { class: 'authority',
    writer: 'services/main/src/modules/access/memberships.ts; services/main/src/modules/access/realm-management-members.ts', writerKind: 'authority command or durable replay evidence' },
  'access.membership_history': { class: 'authority',
    writer: 'services/main/src/modules/access/memberships.ts; services/main/src/modules/access/realm-management-members.ts; services/main/src/modules/realm-admin/join-requests.ts', writerKind: 'authority command or durable replay evidence' },
  'access.membership_policy': { class: 'authority',
    writer: 'services/main/src/modules/access/fixture-authority-scenario.ts; services/main/src/modules/access/managed-organizations.ts; services/main/src/modules/access/realm-initialization.ts; services/main/src/modules/access/realm-management-settings.ts', writerKind: 'authority command or durable replay evidence' },
  'access.mod_work_binding': { class: 'authority',
    writer: 'services/main/src/modules/identity-merge/person-state-coverage.ts; services/main/migrations/access/770_mod_work_binding.sql; services/main/migrations/access/815_mod_work_release.sql', writerKind: 'authority command or durable replay evidence' },
  'access.mod_work_release': { class: 'authority',
    writer: 'services/main/src/modules/package/mod-resolution.ts', writerKind: 'authority command or durable replay evidence' },
  'access.moderation_decision': { class: 'authority',
    writer: 'services/main/src/modules/governance/realm-sanction-appeal.ts; services/main/src/modules/governance/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.moderation_decision_target': { class: 'authority',
    writer: 'services/main/src/modules/governance/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.notification_attempt': { class: 'authority',
    writer: 'services/main/src/modules/notification/dispatcher.ts', writerKind: 'authority command or durable replay evidence' },
  'access.notification_delivery': { class: 'authority',
    writer: 'services/main/src/modules/notification/dispatcher.ts; services/main/src/modules/notification/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.notification_digest_candidate': { class: 'authority',
    writer: 'services/main/src/modules/notification/digest.ts; services/main/src/modules/notification/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.notification_digest_day': { class: 'authority',
    columns: { principal_id: 'authority', day: 'authority', state: 'operational', lease_until: 'operational' },
    reason: 'Durable job identities stay exact; worker traversal and scheduling are excluded and kept from the backup.',
    writer: 'services/main/src/modules/notification/digest.ts; services/main/src/modules/notification/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.notification_display_context': { class: 'authority',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_endpoint': { class: 'authority',
    writer: 'services/main/src/modules/notification/dispatcher.ts; services/main/src/modules/notification/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.notification_filter_bounds': { class: 'derived-projection',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.notification_filter_seek': { class: 'derived-projection',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.notification_item': { class: 'authority',
    writer: 'services/main/src/modules/notification/dispatcher.ts; services/main/src/modules/notification/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.notification_item_read': { class: 'authority',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_item_triage': { class: 'authority',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_preference': { class: 'authority',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_preference_change': { class: 'authority',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_producer_cursor': { class: 'operational',
    writer: 'services/main/src/modules/notification-producers/producer.ts', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.notification_producer_event': { class: 'authority',
    writer: 'services/main/src/modules/horizon/lag.ts; services/main/src/modules/notification-producers/access-log.ts; services/main/migrations/access/1130_notification_producer_insert_log.sql; services/main/migrations/access/495_notification_producer_log.sql; services/main/migrations/access/622_review_notifications.sql; services/main/migrations/access/701_realm_invitation_notifications.sql; services/main/migrations/access/831_feed_notification_events.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_proposal_context': { class: 'authority',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_provider_event': { class: 'authority',
    writer: 'services/main/src/modules/notification/dispatcher.ts', writerKind: 'authority command or durable replay evidence' },
  'access.notification_read_watermark': { class: 'authority',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_realm_effect': { class: 'authority',
    writer: 'services/main/src/modules/follows/recipients.ts; services/main/src/modules/notification-producers/subjects.ts; services/main/migrations/access/495_notification_producer_log.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_realm_pending': { class: 'authority',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_recipient_progress': { class: 'operational',
    reason: 'Fanout traversal is pruned after completion; delivery evidence is retained separately. Restore keeps the backup progress.',
    writer: 'services/main/src/modules/notification-producers/producer.ts; services/main/src/modules/notification-producers/saved-views.ts; services/main/src/modules/notification/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.notification_seen': { class: 'authority',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'authority command or durable replay evidence' },
  'access.notification_stream': { class: 'authority',
    writer: 'services/main/src/modules/notification/store.ts; services/main/migrations/access/1830_notification_filter_seek.sql', writerKind: 'authority command or durable replay evidence' },
  'access.operational_bounds_activation': { class: 'authority',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'authority command or durable replay evidence' },
  'access.operational_bounds_profile': { class: 'authority',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'authority command or durable replay evidence' },
  'access.org_participation_subject': { class: 'authority',
    writer: 'services/main/src/modules/access/grants.ts; services/main/src/modules/access/managed-org-authority.ts; services/main/src/modules/access/org-realm-participation.ts; services/main/src/modules/access/organization-moderation.ts; services/main/migrations/access/025_org_realm_participation.sql; services/main/migrations/access/026_managed_organization.sql; services/main/migrations/access/027_organization_publication_moderation.sql', writerKind: 'authority command or durable replay evidence' },
  'access.org_realm_ban': { class: 'authority',
    writer: 'services/main/src/modules/access/org-realm-participation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.org_realm_history': { class: 'authority',
    writer: 'services/main/src/modules/access/org-realm-participation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.org_realm_move': { class: 'authority',
    writer: 'services/main/src/modules/access/org-realm-participation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.org_realm_participation': { class: 'authority',
    writer: 'services/main/src/modules/access/org-realm-participation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.org_realm_policy': { class: 'authority',
    writer: 'services/main/src/modules/access/managed-org-authority.ts; services/main/src/modules/access/org-realm-participation.ts; services/main/src/modules/access/organization-moderation.ts; services/main/migrations/access/025_org_realm_participation.sql; services/main/migrations/access/026_managed_organization.sql; services/main/migrations/access/027_organization_publication_moderation.sql', writerKind: 'authority command or durable replay evidence' },
  'access.org_realm_proposal': { class: 'authority',
    writer: 'services/main/src/modules/access/org-realm-participation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.org_realm_proposal_use': { class: 'authority',
    writer: 'services/main/src/modules/access/org-realm-participation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.org_realm_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/org-realm-participation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.org_roster_policy_history': { class: 'authority',
    writer: 'services/main/src/modules/access/managed-organizations.ts', writerKind: 'authority command or durable replay evidence' },
  'access.org_roster_scope': { class: 'authority',
    writer: 'services/main/src/modules/access/eligible-org-member-set.ts; services/main/src/modules/access/represented-membership-authority.ts', writerKind: 'authority command or durable replay evidence' },
  'access.organization_publication_moderation': { class: 'authority',
    writer: 'services/main/src/modules/access/organization-moderation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.outbox': { class: 'authority',
    writer: 'services/main/src/modules/access/admission.ts; services/main/src/modules/access/organization-moderation.ts; services/main/src/modules/governance/store.ts; services/main/src/modules/proposal/access.ts; services/main/src/modules/statement/upgrade.ts; services/main/src/modules/vote/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.owner_consumer_checkpoint': { class: 'operational',
    writer: 'services/main/src/modules/owner/relay-gap.ts', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.owner_consumer_replay': { class: 'authority',
    writer: 'services/main/src/modules/owner/relay-gap.ts', writerKind: 'authority command or durable replay evidence' },
  'access.owner_partition_route': { class: 'authority',
    writer: 'services/main/src/modules/partition/route.ts', writerKind: 'authority command or durable replay evidence' },
  'access.permission_grant': { class: 'authority',
    writer: 'services/main/src/modules/access/fixture-authority-scenario.ts; services/main/src/modules/access/fixture-authority.ts; services/main/src/modules/access/grants.ts; services/main/src/modules/access/invitation.ts; services/main/src/modules/access/join-fixture-consent.ts; services/main/src/modules/access/platform-grants.ts; services/main/src/modules/access/realm-initialization.ts; services/main/src/modules/access/realm-management-members.ts; services/main/src/modules/access/realm-management.ts; services/main/src/modules/access/represented-membership-authority.ts; services/main/src/modules/agent/provision.ts', writerKind: 'authority command or durable replay evidence' },
  'access.person_block': { class: 'authority',
    writer: 'services/main/src/modules/preferences/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.person_block_receipt': { class: 'authority',
    writer: 'services/main/src/modules/preferences/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.person_preferences': { class: 'authority',
    writer: 'services/main/src/modules/preferences/languages.ts; services/main/src/modules/preferences/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.person_preferences_receipt': { class: 'authority',
    writer: 'services/main/src/modules/preferences/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.person_state_merge_receipt': { class: 'authority',
    writer: 'services/main/src/modules/identity-merge/person-effect.ts', writerKind: 'authority command or durable replay evidence' },
  'access.platform_administrator_admission': { class: 'authority',
    writer: 'services/main/src/modules/access/platform-administrator.ts', writerKind: 'authority command or durable replay evidence' },
  'access.platform_assignment_ceiling': { class: 'authority',
    writer: 'services/main/src/modules/access/platform-grants.ts', writerKind: 'authority command or durable replay evidence' },
  'access.platform_grant_change_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/platform-grants.ts', writerKind: 'authority command or durable replay evidence' },
  'access.platform_grant_episode': { class: 'authority',
    writer: 'services/main/src/modules/access/platform-grants.ts', writerKind: 'authority command or durable replay evidence' },
  'access.policy': { class: 'authority',
    writer: 'services/main/src/modules/access/policy-changes.ts', writerKind: 'authority command or durable replay evidence' },
  'access.policy_change_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/policy-changes.ts', writerKind: 'authority command or durable replay evidence' },
  'access.policy_revision': { class: 'authority',
    writer: 'services/main/src/modules/access/policy-changes.ts', writerKind: 'authority command or durable replay evidence' },
  'access.policy_rule': { class: 'authority',
    writer: 'services/main/src/modules/access/policy-changes.ts', writerKind: 'authority command or durable replay evidence' },
  'access.policy_rule_set_reference': { class: 'authority',
    writer: 'services/main/src/modules/access/policy-changes.ts', writerKind: 'authority command or durable replay evidence' },
  'access.policy_set_admission': { class: 'authority',
    writer: 'services/main/src/modules/access/policy-changes.ts', writerKind: 'authority command or durable replay evidence' },
  'access.principal': { class: 'authority',
    writer: 'services/main/src/modules/access/admission.ts; services/main/src/modules/access/fixture-authority-scenario.ts; services/main/src/modules/access/interaction-decisions.ts; services/main/src/modules/access/private-memberships.ts; services/main/src/modules/access/representations.ts; services/main/src/modules/access/represented-membership-authority.ts; services/main/src/modules/agent/provision.ts; services/main/src/modules/notification/store.ts; services/main/src/modules/public-report/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.principal_agent_attribution': { class: 'authority',
    writer: 'services/main/src/modules/access/contexts.ts; services/main/src/modules/access/direct-principal.ts; services/main/migrations/access/012_direct_principal_work_create.sql', writerKind: 'authority command or durable replay evidence' },
  'access.principal_permission_grant': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts', writerKind: 'authority command or durable replay evidence' },
  'access.private_group_member': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts; services/main/src/modules/access/private-recipients.ts', writerKind: 'authority command or durable replay evidence' },
  'access.private_membership': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts', writerKind: 'authority command or durable replay evidence' },
  'access.private_membership_ban': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts; services/main/src/modules/access/realm-management-policy.ts; services/main/src/modules/access/realm-management-settings.ts; services/main/src/modules/access/realm-roles-rating.ts; services/main/src/modules/notification-producers/subjects.ts; services/main/src/modules/realm-admin/join-requests.ts; services/main/src/modules/realm-reply/member-policy.ts; services/main/migrations/access/023_private_principal_membership.sql', writerKind: 'authority command or durable replay evidence' },
  'access.private_membership_change_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts', writerKind: 'authority command or durable replay evidence' },
  'access.private_membership_consent': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts', writerKind: 'authority command or durable replay evidence' },
  'access.private_membership_consent_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts', writerKind: 'authority command or durable replay evidence' },
  'access.private_membership_consent_revocation': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts', writerKind: 'authority command or durable replay evidence' },
  'access.private_membership_consent_use': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts', writerKind: 'authority command or durable replay evidence' },
  'access.private_membership_history': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts', writerKind: 'authority command or durable replay evidence' },
  'access.private_recipient_change_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/private-recipients.ts', writerKind: 'authority command or durable replay evidence' },
  'access.private_role_binding': { class: 'authority',
    writer: 'services/main/src/modules/access/private-memberships.ts; services/main/src/modules/access/private-recipients.ts', writerKind: 'authority command or durable replay evidence' },
  'access.projection_creator_quota': { class: 'authority',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'authority command or durable replay evidence' },
  'access.projection_frame_identity': { class: 'authority',
    writer: 'services/main/src/modules/projection/store.ts; services/main/migrations/access/1090_projection_frame_identity.sql', writerKind: 'authority command or durable replay evidence' },
  'access.projection_identity': { class: 'authority',
    writer: 'services/main/src/modules/projection/store.ts; services/main/migrations/access/1090_projection_frame_identity.sql', writerKind: 'authority command or durable replay evidence' },
  'access.proposal_execution_admission': { class: 'authority',
    writer: 'services/main/src/modules/proposal/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.protected_change_activation': { class: 'authority',
    writer: 'services/main/src/modules/access/agent-control.ts; services/main/src/modules/access/protected-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.protected_change_approval': { class: 'authority',
    writer: 'services/main/src/modules/access/agent-control.ts; services/main/src/modules/access/protected-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.protected_change_proposal': { class: 'authority',
    writer: 'services/main/src/modules/access/agent-control.ts; services/main/src/modules/access/protected-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.protected_set': { class: 'authority',
    writer: 'services/main/src/modules/access/protected-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.public_name_backfill_checkpoint': { class: 'operational',
    writer: 'services/main/src/modules/search/backfill-checkpoint.ts; services/main/src/modules/search/backfill.ts', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.ranking_generation': { class: 'authority',
    writer: 'services/main/src/modules/recommendation/ranking.ts; services/main/migrations/access/1021_discovery_concept_seek.sql; services/main/migrations/access/1023_discovery_topic_membership.sql; services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql; services/main/migrations/access/560_discovery_popular_terms.sql', writerKind: 'authority command or durable replay evidence' },
  'access.ranking_partition': { class: 'operational',
    generationColumn: 'generation_id', generationPayload: true,
    writer: 'services/main/src/modules/recommendation/ranking.ts; services/main/migrations/access/1021_discovery_concept_seek.sql; services/main/migrations/access/1023_discovery_topic_membership.sql; services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql; services/main/migrations/access/560_discovery_popular_terms.sql', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.ranking_score': { class: 'operational',
    generationColumn: 'generation_id', generationPayload: true,
    writer: 'services/main/src/modules/recommendation/ranking.ts; services/main/migrations/access/1021_discovery_concept_seek.sql; services/main/migrations/access/1023_discovery_topic_membership.sql; services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql; services/main/migrations/access/560_discovery_popular_terms.sql', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.ranking_signal_slot': { class: 'operational',
    generationColumn: 'generation_id', generationPayload: true,
    writer: 'services/main/src/modules/recommendation/ranking.ts; services/main/migrations/access/1021_discovery_concept_seek.sql; services/main/migrations/access/1023_discovery_topic_membership.sql; services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql; services/main/migrations/access/560_discovery_popular_terms.sql', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.rating_aggregate_context': { class: 'authority',
    writer: 'services/main/src/modules/rating/aggregate-inventory.ts', writerKind: 'authority command or durable replay evidence' },
  'access.rating_aggregate_head': { class: 'authority',
    writer: 'services/main/src/modules/rating/aggregate-inventory.ts', writerKind: 'authority command or durable replay evidence' },
  'access.rating_merge_selection': { class: 'authority',
    writer: 'services/main/src/modules/rating/merge-handler.ts; services/main/migrations/access/2606_standing_rating_affected_cuts.sql', writerKind: 'authority command, retained lineage binding and bounded revoked-projection cleanup' },
  'access.rating_observation_gate': { class: 'authority',
    writer: 'services/main/src/modules/rating/aggregate-inventory.ts', writerKind: 'authority command or durable replay evidence' },
  'access.rating_standing_component': { class: 'authority',
    writer: 'services/main/migrations/access/2045_standing_rating_components.sql; services/main/migrations/access/2077_standing_rating_publication.sql; services/main/migrations/access/2606_standing_rating_affected_cuts.sql',
    writerKind: 'standing contribution delta trigger',
    reason: 'Exact histogram, unknown count and surviving witness derive from the private effective-person ledger; retain them in the same signed owner cut, never reset them independently.',
    rebuild: 'Reconcile rating_aggregate_head and rating_merge_selection under the publication fence; legacy unknown values require the rating reconstruction manifest/receipt verifier. Restore heads, admissions, selections, merge task/completion evidence and immutable manifests from the same cut before publication.' },
  'access.rating_standing_contribution': { class: 'authority',
    writer: 'services/main/migrations/access/2045_standing_rating_components.sql; services/main/migrations/access/2077_standing_rating_publication.sql; services/main/migrations/access/2606_standing_rating_affected_cuts.sql; services/main/src/modules/rating/standing-publication.ts',
    writerKind: 'head/selection trigger and bounded retained-projection replay',
    reason: 'Native precedence and original sealed value/admission determine each effective person contribution. Its recorded prior value is necessary to subtract a replacement exactly; retain it with components and pending publication work.',
    rebuild: 'Derive effective slots from rating_aggregate_head and rating_merge_selection, respecting completed and interrupted identity_merge_task evidence. Verify unknown original heads with admissions, graph receipts and immutable manifests through the existing reconstruction owner; finish retained projection pages before reopening publication.' },
  'access.rating_standing_change': { class: 'authority',
    writer: 'services/main/migrations/access/2077_standing_rating_publication.sql; services/main/src/modules/rating/standing-publication.ts',
    writerKind: 'append-only pending transition/refresh trigger and bounded maintenance pruning',
    reason: 'Historical publication evidence from the pre-scoped owner. New reads use component revisions and retained affected identity cuts; this history no longer holds unrelated reads behind a transaction horizon.',
    rebuild: 'Retain historical change rows with the authenticated owner cut. Reconcile scoped transition, refresh, dependency and lineage state with heads/components and the identity journal; recovery generation still invalidates old reads across logical restore.' },
  'access.rating_standing_refresh': { class: 'authority',
    writer: 'services/main/migrations/access/2077_standing_rating_publication.sql; services/main/src/modules/rating/standing-publication.ts',
    writerKind: 'origin head trigger and bounded reconstruction continuation',
    reason: 'The source-bound keyset cursor retains unpublished projections. A newer seal rewinds it atomically; deleting progress independently would falsely reopen publication.',
    rebuild: 'Restore with original rating_aggregate_head, rating_merge_selection, dependency/lineage and contributions/components. Resume indexed pages under recovery/authority/source gates; every continuation rechecks revocation. Only stale affected components wait; unrelated cuts remain readable.' },
  'access.rating_standing_transition': { class: 'authority',
    writer: 'services/main/src/modules/rating/standing-publication.ts; services/main/src/modules/work/merge-command.ts; services/main/migrations/access/2606_standing_rating_affected_cuts.sql',
    writerKind: 'independently committed pre-identity fence and journal completion trigger',
    reason: 'Independently committed Work/Main Version pair and original merge bind the affected publication cut. The fence can outlive a rolled-back journal; durable completion marks it finished but preserves cut/revocation evidence, including for inherited descendants.',
    rebuild: 'Restore with identity_merge_task/items/outcomes/completion, rating selections, lineage/dependencies and graph identity receipts at the authenticated owner cut. Resume the exact task; only its durable completion finishes the fence. Retain finished cuts and remove revoked inherited selections through bounded owner continuation. Upgrade refuses an unbound orphan fence until its journal is recovered; never guess its affected pair or erase its revocation.' },
  'access.rating_standing_dependency': { class: 'authority',
    writer: 'services/main/migrations/access/2606_standing_rating_affected_cuts.sql', writerKind: 'effective contribution delta trigger',
    reason: 'Origin and merge provenance counts group the effective component without scanning its rating population. Each slot delta updates a bounded number of entries under the existing target gate.',
    rebuild: 'Recount from rating_standing_contribution, including native precedence and merge_lineage, while the authenticated recovery hold is closed. Restore with components, contributions, scoped transitions and lineage before admitting publication.' },
  'access.rating_standing_lineage': { class: 'authority',
    writer: 'services/main/migrations/access/2606_standing_rating_affected_cuts.sql', writerKind: 'selection trigger reading retained rating merge items',
    reason: 'Immutable path nodes group equal inherited histories without conflating people carried by the same task through different ancestors. A path remains necessary after the original pair selection was removed, so a native witness cannot attest a revoked descendant contribution.',
    rebuild: 'Resolve paths from the authoritative rating identity_merge_item before_state and lineage members, linking only the effective inherited source selection. Missing or cyclic old snapshots refuse upgrade. Restore immutable items, members, merge tasks/completions, scoped transitions and selections from the same signed cut; run bounded revoked-selection cleanup before affected publication.' },
  'access.rating_standing_lineage_member': { class: 'authority',
    writer: 'services/main/migrations/access/2606_standing_rating_affected_cuts.sql', writerKind: 'selection trigger binding an immutable person snapshot to a retained path',
    reason: 'A later merge needs the exact earlier path for that person even after the source selection is removed. One indexed parent binding and at most two inserts bound native delivery work independently of ancestry depth.',
    rebuild: 'Reconstruct from complete immutable rating identity_merge_item snapshots together with lineage paths under the authenticated recovery hold. Restore members, path nodes, selections, contributions, dependencies and identity completion evidence at one signed cut; never infer a missing parent from a different person or task.' },
  'access.rating_standing_cut': { class: 'authority',
    writer: 'services/main/migrations/access/2607_standing_rating_bounded_progress.sql; services/main/src/modules/rating/standing-publication.ts',
    writerKind: 'per-component publication counter',
    reason: 'Revision and pending count fence exact reads without retaining a scan over finished identity history.',
    rebuild: 'Reconcile counters from cut_fence and registration with the authenticated component, transition and progress cut before publication.' },
  'access.rating_standing_cut_fence': { class: 'authority',
    writer: 'services/main/migrations/access/2607_standing_rating_bounded_progress.sql; services/main/src/modules/rating/standing-publication.ts',
    writerKind: 'bounded transition preparation, completion and cleanup',
    reason: 'Affected Context/Main Version membership must be committed before graph effects; releasing it early could attest a revoked descendant.',
    rebuild: 'Restore with graph identity receipts, transition/progress/walk state and component cuts. Resume the exact prepared task and release only after its bounded cleanup is exhausted.' },
  'access.rating_standing_progress': { class: 'authority',
    writer: 'services/main/migrations/access/2607_standing_rating_bounded_progress.sql; services/main/src/modules/rating/standing-publication.ts',
    writerKind: 'bounded transition and cleanup cursor',
    reason: 'Preparation and release phases retain discovery progress across interruptions, including exhausted history.',
    rebuild: 'Restore with transitions, revocation roots, lineage/walk state, component fences and identity journal/receipts. A prepared fence authorizes graph work only for its bound task; never infer preparation from a read.' },
  'access.rating_standing_walk': { class: 'authority',
    writer: 'services/main/migrations/access/2607_standing_rating_bounded_progress.sql; services/main/src/modules/rating/standing-publication.ts',
    writerKind: 'bounded retained-lineage traversal and selection cleanup',
    reason: 'Each retained lineage keeps its own edge, component and selection cursor; a mutation limit alone cannot bound discovery.',
    rebuild: 'Restore with immutable lineage/member bindings, revocation pointers, selections, transition/progress and component fences from one signed cut. Resume pages without discarding descendant evidence.' },
  'access.rating_standing_revocation': { class: 'authority',
    writer: 'services/main/migrations/access/2607_standing_rating_bounded_progress.sql; services/main/src/modules/rating/standing-publication.ts',
    writerKind: 'pre-identity fence binding an original merge to its first revoker',
    reason: 'New roots and descendants inherit a retained revocation pointer without walking ancestry. The binding outlives cleanup and finished journal history.',
    rebuild: 'Restore with original and revoking identity task/items/completion, lineage/member bindings and graph receipts. Never remove a root binding because its current selections were exhausted.' },
  'access.rating_standing_registration': { class: 'authority',
    writer: 'services/main/migrations/access/2607_standing_rating_bounded_progress.sql; services/main/src/modules/rating/standing-publication.ts',
    writerKind: 'effective-origin delta and bounded transition registration',
    reason: 'A newly effective origin is held locally until it has registered all open identity cuts; concurrent discovery cannot publish a gap.',
    rebuild: 'Restore with effective contributions/dependencies, component cuts/fences, open transitions and progress. Resume the indexed task cursor before removing its local hold.' },
  'access.rating_standing_bootstrap': { class: 'authority',
    writer: 'services/main/migrations/access/2607_standing_rating_bounded_progress.sql; services/main/src/modules/rating/standing-publication.ts',
    writerKind: 'forward migration and bounded legacy publication reconciliation',
    reason: 'Legacy inherited cuts stay unavailable until durable old-revocation discovery is complete; native unrelated components remain readable.',
    rebuild: 'Restore with legacy lineage, selections, identity journal/completion and progress. Release each component only after all legacy discovery cursors have exhausted; preserve recovery generation across restores.' },
  'access.read_ranking_admission': { class: 'derived-projection',
    writer: 'services/main/src/modules/feed/ranking-admission.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.read_ranking_admitted': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/projection.ts; services/main/src/modules/rankings/store.ts; services/main/migrations/access/1031_admitted_read_rankings.sql; services/main/migrations/access/1788_read_ranking_population.sql', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.read_ranking_checkpoint': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.read_ranking_pending': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.read_ranking_publication': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.read_ranking_removal': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.read_ranking_score': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.read_ranking_target': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.reader_review': { class: 'authority',
    writer: 'services/main/src/modules/review/merge-handler.ts; services/main/src/modules/review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.reader_review_collection': { class: 'authority',
    writer: 'services/main/src/modules/governance/report-review.ts; services/main/src/modules/review/merge-handler.ts; services/main/src/modules/review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.reader_review_event': { class: 'authority',
    writer: 'services/main/src/modules/review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.reader_review_milestone': { class: 'authority',
    writer: 'services/main/src/modules/notification/producer-review.ts; services/main/migrations/access/622_review_notifications.sql', writerKind: 'authority command or durable replay evidence' },
  'access.reader_review_rank_change': { class: 'authority',
    writer: 'services/main/src/modules/horizon/lag.ts; services/main/src/modules/rankings/projection.ts; services/main/migrations/access/1170_review_rank_sequencer.sql; services/main/migrations/access/1424_review_rank_enqueue_time.sql; services/main/migrations/access/1788_read_ranking_population.sql; services/main/migrations/access/623_review_rankings.sql', writerKind: 'authority command or durable replay evidence' },
  'access.reader_review_rank_head': { class: 'authority',
    writer: 'services/main/src/modules/rankings/projection.ts; services/main/src/modules/rankings/store.ts; services/main/migrations/access/1031_admitted_read_rankings.sql; services/main/migrations/access/1788_read_ranking_population.sql', writerKind: 'authority command or durable replay evidence' },
  'access.reader_review_receipt': { class: 'authority',
    writer: 'services/main/src/modules/review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.reader_review_revision': { class: 'authority',
    writer: 'services/main/src/modules/review/merge-handler.ts; services/main/src/modules/review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.reader_review_vote': { class: 'authority',
    writer: 'services/main/src/modules/review/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.reader_variant_preference': { class: 'authority',
    writer: 'services/main/src/modules/work/native-variants.ts', writerKind: 'authority command or durable replay evidence' },
  'access.reader_variant_preference_receipt': { class: 'authority',
    writer: 'services/main/src/modules/work/native-variants.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_admin_assignment': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-management-members.ts; services/main/src/modules/access/realm-management.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_admin_escalation': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-management.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_admin_owner_bootstrap': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-initialization.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_admin_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-initialization.ts; services/main/src/modules/access/realm-management.ts; services/main/src/modules/governance/realm-sanction-appeal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_admin_revision': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-initialization.ts; services/main/src/modules/access/realm-management-joining.ts; services/main/src/modules/access/realm-management-settings.ts; services/main/src/modules/access/realm-management.ts; services/main/src/modules/governance/realm-sanction-appeal.ts; services/main/src/modules/realm-admin/join-requests.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_admin_role': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-management.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_admin_role_grant': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-management-members.ts; services/main/src/modules/access/realm-management.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_admin_settings': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-management-settings.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_count_change': { class: 'derived-projection',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.realm_count_position': { class: 'authority',
    writer: 'services/main/src/modules/realm-directory/index.ts; services/main/migrations/access/1172_ordered_read_change_signals.sql; services/main/migrations/access/1240_ordered_read_fences.sql; services/main/migrations/access/395_realm_member_publication.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_creation_initialization': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-initialization.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_growth_change': { class: 'derived-projection',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.realm_growth_day': { class: 'derived-projection',
    writer: 'services/main/src/modules/realm-directory/index.ts; services/main/migrations/access/1172_ordered_read_change_signals.sql; services/main/migrations/access/1240_ordered_read_fences.sql; services/main/migrations/access/395_realm_member_publication.sql', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.realm_growth_position': { class: 'derived-projection',
    writer: 'services/main/src/modules/realm-directory/index.ts; services/main/migrations/access/1172_ordered_read_change_signals.sql; services/main/migrations/access/1240_ordered_read_fences.sql; services/main/migrations/access/395_realm_member_publication.sql', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.realm_history_admission': { class: 'authority',
    writer: 'services/main/src/modules/realm-admin/history.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_invitation': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-management-joining.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_join_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-management-joining.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_join_request': { class: 'authority',
    writer: 'services/main/src/modules/realm-admin/join-requests.ts; services/main/migrations/access/1006_realm_join_request_inbox_revision.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_join_request_basis': { class: 'authority',
    writer: 'services/main/src/modules/realm-admin/join-requests.ts; services/main/migrations/access/1006_realm_join_request_inbox_revision.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_join_request_command_receipt': { class: 'authority',
    writer: 'services/main/src/modules/realm-admin/join-requests.ts; services/main/migrations/access/1006_realm_join_request_inbox_revision.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_join_request_decision': { class: 'authority',
    writer: 'services/main/src/modules/realm-admin/join-requests.ts; services/main/migrations/access/1006_realm_join_request_inbox_revision.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_join_request_inbox_revision': { class: 'authority',
    writer: 'services/main/src/modules/realm-admin/join-requests.ts; services/main/migrations/access/1006_realm_join_request_inbox_revision.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_join_request_member_revision': { class: 'authority',
    writer: 'services/main/src/modules/realm-admin/join-requests.ts; services/main/migrations/access/1006_realm_join_request_inbox_revision.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_join_request_pending': { class: 'authority',
    writer: 'services/main/src/modules/realm-admin/join-requests-read.ts; services/main/src/modules/realm-admin/join-requests.ts; services/main/migrations/access/1003_realm_join_request_decisions.sql; services/main/migrations/access/1006_realm_join_request_inbox_revision.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_join_request_receipt': { class: 'authority',
    writer: 'services/main/src/modules/realm-admin/join-requests.ts; services/main/migrations/access/1006_realm_join_request_inbox_revision.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_management_activity': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-management-managed.ts; services/main/migrations/access/1767_realm_review_pending_queue.sql; services/main/migrations/access/1779_realm_sanction_appeal_queue.sql; services/main/migrations/access/601_realm_management_activity.sql; services/main/migrations/access/700_decided_realm_queue.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_management_read_revision': { class: 'authority',
    writer: 'services/main/src/modules/management-reads/read-store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_member_count': { class: 'authority',
    writer: 'services/main/src/modules/access/admission.ts; services/main/src/modules/governance/rules.ts; services/main/src/modules/realm-directory/index.ts; services/main/migrations/access/1172_ordered_read_change_signals.sql; services/main/migrations/access/395_realm_member_publication.sql; services/main/migrations/access/396_realm_directory.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_native_variant_recommendation': { class: 'authority',
    writer: 'services/main/src/modules/work/realm-variant-recommendation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_native_variant_recommendation_receipt': { class: 'authority',
    writer: 'services/main/src/modules/work/realm-variant-recommendation.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_policy_delivery': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-initialization.ts; services/main/src/modules/access/realm-management-recovery.ts; services/main/src/modules/access/realm-management.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_rating_admission': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-roles-rating.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_roster_listing': { class: 'authority',
    writer: 'services/main/src/modules/access/realm-management-joining.ts; services/main/src/modules/access/roster.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_sanction_appeal': { class: 'authority',
    writer: 'services/main/src/modules/governance/realm-sanction-appeal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_sanction_lift': { class: 'authority',
    writer: 'services/main/src/modules/governance/realm-sanction-appeal.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_submission': { class: 'authority',
    writer: 'services/main/src/modules/realm-submission/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_submission_author_revision': { class: 'authority',
    writer: 'services/main/src/modules/realm-submission/reads.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_submission_operation': { class: 'authority',
    writer: 'services/main/src/modules/realm-submission/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.realm_submission_revision': { class: 'authority',
    writer: 'services/main/src/modules/notification-producers/producer.ts; services/main/src/modules/notification-producers/subjects.ts; services/main/migrations/access/360_realm_submission.sql', writerKind: 'authority command or durable replay evidence' },
  'access.realm_submission_work_revision': { class: 'authority',
    writer: 'services/main/migrations/access/2075_work_submission_pages.sql; services/main/src/modules/realm-submission/reads.ts',
    writerKind: 'submission-change trigger and pagination owner',
    reason: 'The audience/Work revision fences retained submission cursors. Restore it with submission decisions; reconstruction requires a new recovery generation before revisions can restart.' },
  'access.realm_thread_checkpoint': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/realm-threads.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.realm_thread_dirty': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/realm-threads.ts; services/main/src/modules/rankings/retirement.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.realm_thread_order': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/realm-threads.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.realm_thread_population': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/realm-threads.ts; services/main/src/modules/rankings/retirement.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.realm_thread_population_admission': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/realm-threads.ts; services/main/src/modules/rankings/retirement.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.realm_thread_population_job': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/realm-threads.ts; services/main/src/modules/rankings/retirement.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.realm_thread_private_order': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/realm-threads.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.realm_thread_reference': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/realm-threads.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.realm_thread_state': { class: 'derived-projection',
    writer: 'services/main/src/modules/rankings/realm-threads.ts; services/main/src/modules/realm-reply/thread-store.ts; services/main/migrations/access/1038_realm_thread_ranking.sql; services/main/migrations/access/1131_score_changes_keep_revisions.sql', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.recipient_group': { class: 'authority',
    writer: 'services/main/src/modules/access/groups.ts; services/main/src/modules/access/protected-set.ts', writerKind: 'authority command or durable replay evidence' },
  'access.recovery_fence': { class: 'authority',
    writer: 'services/main/src/modules/access/admission.ts', writerKind: 'authority command or durable replay evidence' },
  'access.relationship_recovery_cursor': { class: 'operational',
    writer: 'services/main/src/modules/follows/recovery.ts; services/main/src/modules/library/follows.ts', writerKind: 'scheduler or progress worker',
    reason: 'The owner advances scheduling, counters or replay/build progress independently of durable authority.',
  },
  'access.representation': { class: 'authority',
    writer: 'services/main/src/modules/access/agent-control.ts; services/main/src/modules/access/fixture-authority-scenario.ts; services/main/src/modules/access/fixture-authority.ts; services/main/src/modules/access/invitation.ts; services/main/src/modules/access/protected-set.ts; services/main/src/modules/access/realm-initialization.ts; services/main/src/modules/access/representations.ts; services/main/src/modules/access/represented-membership-authority.ts; services/main/src/modules/access/topology-policy.ts; services/main/src/modules/agent/provision.ts', writerKind: 'authority command or durable replay evidence' },
  'access.representation_change_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/representations.ts', writerKind: 'authority command or durable replay evidence' },
  'access.representation_edge': { class: 'authority',
    writer: 'services/main/src/modules/access/agent-control.ts; services/main/src/modules/access/fixture-authority.ts; services/main/src/modules/access/invitation.ts; services/main/src/modules/access/topology.ts', writerKind: 'authority command or durable replay evidence' },
  'access.representation_path_proof': { class: 'authority',
    writer: 'services/main/src/modules/access/represented-work-proof.ts; services/main/src/modules/access/topology.ts', writerKind: 'authority command or durable replay evidence' },
  'access.representation_path_step': { class: 'authority',
    writer: 'services/main/src/modules/access/represented-work-proof.ts; services/main/src/modules/access/topology.ts', writerKind: 'authority command or durable replay evidence' },
  'access.representation_request': { class: 'authority',
    writer: 'services/main/src/modules/access/representations.ts; services/main/src/modules/access/represented-membership-authority.ts', writerKind: 'authority command or durable replay evidence' },
  'access.representative_policy': { class: 'authority',
    writer: 'services/main/src/modules/access/topology-policy.ts', writerKind: 'authority command or durable replay evidence' },
  'access.representative_policy_revision': { class: 'authority',
    writer: 'services/main/src/modules/access/topology-policy.ts', writerKind: 'authority command or durable replay evidence' },
  'access.represented_membership_authority_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/represented-membership-authority.ts', writerKind: 'authority command or durable replay evidence' },
  'access.revocation': { class: 'authority',
    writer: 'services/main/src/modules/access/policy-transaction.ts; services/main/src/modules/access/revocation-requests.ts', writerKind: 'authority command or durable replay evidence' },
  'access.revocation_affected_work': { class: 'authority',
    writer: 'services/main/src/modules/access/policy-transaction.ts', writerKind: 'authority command or durable replay evidence' },
  'access.revocation_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/revocation-requests.ts', writerKind: 'authority command or durable replay evidence' },
  'access.rights_complaint': { class: 'authority',
    writer: 'services/main/src/modules/governance/store.ts; services/main/src/modules/public-report/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.rights_counter_notice': { class: 'authority',
    writer: 'services/main/src/modules/governance/store.ts; services/main/src/modules/rights/counter-notice-worker.ts; services/main/src/modules/rights/counter-notice.ts', writerKind: 'authority command or durable replay evidence' },
  'access.role_binding': { class: 'authority',
    writer: 'services/main/src/modules/access/protected-set.ts; services/main/src/modules/access/roles.ts', writerKind: 'authority command or durable replay evidence' },
  'access.role_binding_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/roles.ts', writerKind: 'authority command or durable replay evidence' },
  'access.role_family': { class: 'authority',
    writer: 'services/main/src/modules/access/protected-set.ts; services/main/src/modules/access/roles.ts', writerKind: 'authority command or durable replay evidence' },
  'access.role_revision': { class: 'authority',
    writer: 'services/main/src/modules/access/protected-set.ts; services/main/src/modules/access/roles.ts', writerKind: 'authority command or durable replay evidence' },
  'access.role_revision_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/roles.ts', writerKind: 'authority command or durable replay evidence' },
  'access.safety_alert': { class: 'authority',
    writer: 'services/main/src/modules/safety-alerts/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.safety_case_claim': { class: 'authority',
    writer: 'services/main/src/modules/governance/store.ts; services/main/src/modules/safety-queue/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.safety_decision_effect': { class: 'authority',
    writer: 'services/main/src/modules/governance/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.safety_decision_operation': { class: 'authority',
    writer: 'services/main/src/modules/governance/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.safety_notice_job': { class: 'authority',
    columns: { decision_id: 'authority', ordinal: 'authority', target: 'authority', participant: 'authority', phase: 'operational', after_subject: 'operational', subject: 'operational', after_principal: 'operational' },
    reason: 'Durable job identities stay exact; worker traversal and scheduling are excluded and kept from the backup.',
    writer: 'services/main/src/modules/governance/notices-mail.ts; services/main/src/modules/governance/notices.ts; services/main/src/modules/governance/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.safety_notice_mail_cursor': { class: 'authority',
    columns: { decision_id: 'authority', phase: 'operational', after_party: 'operational', after_report_at: 'operational', after_report: 'operational' },
    reason: 'Durable job identities stay exact; worker traversal and scheduling are excluded and kept from the backup.',
    writer: 'services/main/src/modules/governance/notices-mail.ts', writerKind: 'authority command or durable replay evidence' },
  'access.safety_notice_mail_receipt': { class: 'authority',
    writer: 'services/main/src/modules/governance/notices-mail.ts', writerKind: 'authority command or durable replay evidence' },
  'access.safety_party_notice': { class: 'authority',
    writer: 'services/main/src/modules/governance/notices.ts', writerKind: 'authority command or durable replay evidence' },
  'access.saved_filter': { class: 'authority',
    writer: 'services/main/src/modules/saved-filter/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.saved_filter_inventory': { class: 'authority',
    writer: 'services/main/src/modules/saved-filter/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.saved_filter_receipt': { class: 'authority',
    writer: 'services/main/src/modules/saved-filter/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.scope_gate': { class: 'authority',
    writer: 'services/main/src/modules/access/admission.ts; services/main/src/modules/access/eligible-org-member-set.ts; services/main/src/modules/access/fixture-authority.ts; services/main/src/modules/access/interaction-decisions.ts; services/main/src/modules/access/platform-grants.ts; services/main/src/modules/access/policy-changes.ts; services/main/src/modules/access/policy-transaction.ts; services/main/src/modules/access/realm-initialization.ts; services/main/src/modules/access/realm-management.ts; services/main/src/modules/access/represented-membership-authority.ts; services/main/src/modules/access/scope-gates.ts; services/main/src/modules/access/topology-control.ts; services/main/src/modules/proposal/access.ts; services/main/src/modules/public-report/store.ts; services/main/src/modules/vote/access.ts; services/main/src/modules/work/maintainers.ts', writerKind: 'authority command or durable replay evidence' },
  'access.search_read_lease': { class: 'authority',
    writer: 'services/main/src/modules/access/admission.ts; services/main/src/modules/contribution/private-search-settlement.ts; services/main/src/modules/search-disclosure/content-read-lease.ts', writerKind: 'authority command or durable replay evidence' },
  'access.selected_org_membership_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/memberships.ts', writerKind: 'authority command or durable replay evidence' },
  'access.serial_chapter': { class: 'derived-projection',
    writer: 'services/main/src/modules/work/serial-projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.serial_content_words': { class: 'derived-projection',
    writer: 'services/main/src/modules/work/serial-projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.serial_stats_checkpoint': { class: 'derived-projection',
    writer: 'services/main/src/modules/work/serial-projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.serial_summary': { class: 'derived-projection',
    writer: 'services/main/src/modules/work/serial-projection.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.session_agent': { class: 'authority',
    writer: 'services/main/src/modules/access/session-agent.ts; services/main/migrations/access/310_session_agent.sql', writerKind: 'authority command or durable replay evidence' },
  'access.session_agent_receipt': { class: 'authority',
    writer: 'services/main/src/modules/access/session-agent.ts; services/main/migrations/access/310_session_agent.sql', writerKind: 'authority command or durable replay evidence' },
  'access.site_moderation_change': { class: 'derived-projection',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'projection folding or retention worker',
    reason: 'Worker folding, projection or retention changes rows between cuts; restore keeps the backup rows.', },
  'access.site_moderation_position': { class: 'authority',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'authority command or durable replay evidence' },
  'access.statement_publication_seek_coverage': { class: 'derived-projection',
    writer: 'services/main/src/modules/statement/publication-seek.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.statement_seek': { class: 'derived-projection',
    writer: 'services/main/src/modules/statement/publication-seek.ts; services/main/src/modules/statement/seek.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.statement_seek_coverage': { class: 'derived-projection',
    writer: 'services/main/src/modules/statement/populated-conversion.ts; services/main/src/modules/statement/publication-seek.ts; services/main/src/modules/statement/seek.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.storage_format': { class: 'authority',
    writer: 'services/main/migrations/access/1043_discovery_versions.sql; services/main/migrations/access/1044_discovery_scheduling.sql; services/main/migrations/access/1045_discovery_read_seeks.sql', writerKind: 'authority command or durable replay evidence' },
  'access.suitability_assessment': { class: 'authority',
    writer: 'services/main/src/modules/suitability/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.target_rating_component': { class: 'authority',
    writer: 'services/main/src/modules/rating/aggregate-inventory.ts', writerKind: 'authority command or durable replay evidence' },
  'access.target_rating_head': { class: 'authority',
    writer: 'services/main/src/modules/rating/aggregate-inventory.ts', writerKind: 'authority command or durable replay evidence' },
  'access.template_discovery_basis': { class: 'derived-projection',
    writer: 'services/main/src/modules/query/template-read.ts; services/main/migrations/access/1762_template_discovery_basis.sql', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.template_seek_basis': { class: 'derived-projection',
    writer: 'services/main/src/modules/query/seek-index.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.template_seek_checkpoint': { class: 'derived-projection',
    writer: 'services/main/src/modules/query/seek-index.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.template_seek_entity': { class: 'derived-projection',
    writer: 'services/main/src/modules/query/seek-index.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.template_seek_entry': { class: 'derived-projection',
    writer: 'services/main/src/modules/query/seek-index.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.template_seek_pending': { class: 'derived-projection',
    writer: 'services/main/src/modules/query/seek-index.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.template_seek_pending_anchor': { class: 'derived-projection',
    writer: 'services/main/src/modules/query/seek-index.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.type_admission_receipt': { class: 'authority',
    writer: 'services/main/src/modules/types/store.ts', writerKind: 'authority command or durable replay evidence' },
  'access.vote_admission': { class: 'authority',
    writer: 'services/main/src/modules/vote/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.vote_representative_policy': { class: 'authority',
    writer: 'services/main/src/modules/vote/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.vote_representative_policy_member': { class: 'authority',
    writer: 'services/main/src/modules/vote/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.vote_representative_policy_receipt': { class: 'authority',
    writer: 'services/main/src/modules/vote/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.vote_representative_policy_revision': { class: 'authority',
    writer: 'services/main/src/modules/vote/access.ts', writerKind: 'authority command or durable replay evidence' },
  'access.watch': { class: 'authority',
    columns: { principal_id: 'authority', proposal: 'authority', reason: 'authority', level: 'authority', revision: 'authority',
      target: 'authority', kind: 'authority', manual_choice: 'authority', changed_at: 'authority' },
    authorityWhere: `NOT (t.kind = 'thread' AND t.reason <> 'manual' AND NOT t.manual_choice)`,
    reason: 'Manual preferences remain exact; automatic thread watches are derived participation state pruned by their owner. All backup rows are kept.',
    writer: 'services/main/src/modules/notification-producers/editorial.ts; services/main/src/modules/notification-producers/producer.ts; services/main/src/modules/notification/store.ts; services/main/src/modules/notification/watch.ts', writerKind: 'watch authority commands and automatic participation projection/retention' },
  'access.watch_participation': { class: 'derived-projection',
    reason: 'The producer derives participation from source events; automatic-watch expiry cascades into this cache. Restore keeps the backup rows.',
    writer: 'services/main/src/modules/notification-producers/producer.ts', writerKind: 'participation projection worker' },
  'access.watch_receipt': { class: 'authority',
    writer: 'services/main/src/modules/notification/watch.ts', writerKind: 'authority command or durable replay evidence' },
  'access.work_maintainer': { class: 'authority',
    writer: 'services/main/src/modules/work/maintainer-proof.ts; services/main/src/modules/work/maintainers.ts', writerKind: 'authority command or durable replay evidence' },
  'access.work_maintainer_receipt': { class: 'authority',
    writer: 'services/main/src/modules/work/maintainer-proof.ts; services/main/src/modules/work/maintainers.ts', writerKind: 'authority command or durable replay evidence' },
  'access.work_maintainer_set': { class: 'authority',
    writer: 'services/main/src/modules/work/maintainer-proof.ts; services/main/src/modules/work/maintainers.ts', writerKind: 'authority command or durable replay evidence' },
  'access.zone_browse_entry': { class: 'derived-projection',
    writer: 'services/main/src/modules/zone-browse/store.ts', writerKind: 'projection worker',
    reason: 'The owner advances this projection between cuts; restore keeps the backup rows.',
  },
  'access.realm_directory': {
    class: 'derived-projection',
    writer: 'services/main/src/modules/realm-directory/index.ts; services/main/migrations/access/396_realm_directory.sql', writerKind: 'projection worker and source invalidation trigger',
    reason: 'Graph refreshes and membership-count triggers update both cached directory generations after the backup.',
    reset: 'DELETE FROM access.realm_directory',
    rebuild: 'RealmDirectoryIndex.refresh (services/main/src/modules/realm-directory/index.ts)',
  },
  'access.realm_directory_growth': {
    class: 'derived-projection',
    writer: 'services/main/src/modules/realm-directory/index.ts; services/main/migrations/access/2600_realm_directory_growth_seek.sql',
    writerKind: 'directory worker and per-Realm growth trigger',
    reason: 'Rolling ranks are rebuilt from retained daily growth by the directory worker.',
    reset: 'DELETE FROM access.realm_directory_growth',
    rebuild: 'RealmDirectoryIndex.refresh (services/main/src/modules/realm-directory/index.ts)',
  },
  'access.realm_directory_position': {
    class: 'derived-projection',
    writer: 'services/main/src/modules/realm-directory/index.ts', writerKind: 'projection worker',
    reason: 'The background graph reader advances the cursor independently of Access authority.',
    reset: `UPDATE access.realm_directory_position SET data_epoch = NULL, sequence = 0,
      target_sequence = NULL, refresh_after = '', rebuilding = true, generation = 0,
      revision = revision + 1, build_data_epoch = NULL, build_base_sequence = 0,
      phase = 'idle', spare_sequence = NULL, growth_day = NULL, growth_target_day = NULL,
      growth_after_generation = 0, growth_after_realm = '' WHERE singleton`,
    rebuild: 'RealmDirectoryIndex.refresh (services/main/src/modules/realm-directory/index.ts)',
  },
  'access.rate_limit_v1': {
    class: 'operational',
    writer: 'services/main/src/modules/rate-limit/store.ts', writerKind: 'request counter and expiry worker',
    reason: 'Request counters and expiry cleanup advance independently of durable authority.',
    reset: 'DELETE FROM access.rate_limit_v1',
    rebuild: 'PostgresRateLimitStore.consume (services/main/src/modules/rate-limit/store.ts)',
  },
  'access.derived_generation': {
    class: 'authority',
    columns: {
      id: 'authority', family: 'authority', scope_key: 'authority',
      input_digest: 'authority', input_manifest: 'authority', validation_digest: 'authority',
      created_at: 'authority', ready_at: 'authority',
      state: 'operational', lease_epoch: 'operational', lease_expires_at: 'operational',
      failure_reason: 'operational', finished_at: 'operational',
    },
    operationalWhen: { column: 'state', value: 'building' },
    writer: 'services/main/src/modules/recommendation/derived-generation.ts; services/main/src/modules/discovery/store.ts; services/main/src/modules/also-enjoyed/store.ts', writerKind: 'immutable generation identity with mutable lease',
    reason: 'Only an in-progress build has mutable lease state; closed generations and receipt identities remain exact.',
    // NULL expiry violates the building-state CHECK. Expiry in the past lets
    // claimLease take it again; advancing the epoch fences the restored holder.
    leaseFloor: 'derivedGeneration',
    reset: `UPDATE access.derived_generation SET lease_epoch = greatest(lease_epoch, $1::bigint) + 1,
      lease_expires_at = '-infinity'::timestamptz WHERE state = 'building'`,
    rebuild: 'RankingGenerations.claim / RankingBuildWorker.tick (services/main/src/modules/recommendation)',
  },
};

export function accessRecoveryRule(table: OwnerTable): AccessRecoveryRule {
  const rule = ACCESS_RECOVERY_CLASSIFICATION[table.name];
  // Omission must never skip a newly introduced authority relation or key.
  if (table.schema !== 'access' || !rule
    || rule.columns && table.key.some(name => (Object.hasOwn(rule.columns!, name) ? rule.columns![name] : 'authority') !== 'authority')) {
    return { class: 'authority' };
  }
  if (rule.authorityWhere && (!rule.columns
    || table.columns.some(column => !Object.hasOwn(rule.columns!, column.split(' ')[0]!))
    || Object.keys(rule.columns).some(column => !table.columns.some(value => value.split(' ')[0] === column)))) {
    return { class: 'authority' };
  }
  return rule;
}

/** Enumeration is stricter than runtime: new state needs an explicit decision. */
export function assertAccessRecoveryClassification(catalog: OwnerCatalog): void {
  for (const table of catalog.tables) {
    if (table.schema !== 'access') continue;
    const rule = ACCESS_RECOVERY_CLASSIFICATION[table.name];
    if (!rule) throw new Error(`Access recovery table is unclassified: ${table.name}`);
    if (table.columns.some(column => column.split(' ')[0] === 'lease_epoch')
      && (rule.class === 'operational' || rule.columns?.lease_epoch === 'operational') && !rule.leaseFloor) {
      throw new Error(`Access recovery operational lease needs a signed monotone floor: ${table.name}`);
    }
    if (rule.columns) {
      const names = table.columns.map(column => column.split(' ')[0]!);
      if (names.some(name => !Object.hasOwn(rule.columns!, name))
        || Object.keys(rule.columns).some(name => !names.includes(name))) {
        throw new Error(`Access recovery column is unclassified or absent: ${table.name}`);
      }
      if (table.key.some(name => rule.columns![name] !== 'authority')) {
        throw new Error(`Access recovery primary key must be authority: ${table.name}`);
      }
    }
  }
  for (const name of Object.keys(catalog.excluded)) {
    if (name.startsWith('access.') && !ACCESS_RECOVERY_CLASSIFICATION[name]) {
      throw new Error(`Access recovery table is unclassified: ${name}`);
    }
  }
}

/** Bind schema, row/column classes, conditional exclusions and resets to custody. */
export function accessRecoveryCatalog(catalog: OwnerCatalog): OwnerCatalog {
  const rules = catalog.tables.map(table => [table.name, accessRecoveryRule(table)]);
  const digest = createHash('sha256').update(JSON.stringify([catalog.digest, rules])).digest('hex');
  return { ...catalog, digest };
}

export function accessAuthorityValues(table: OwnerTable,
  values: Record<string, unknown>, building = false): Record<string, unknown> {
  const rule = accessRecoveryRule(table);
  if (!rule.columns || rule.generationColumn && !building || rule.operationalWhen
    && values[rule.operationalWhen.column] !== rule.operationalWhen.value) return values;
  return Object.fromEntries(Object.entries(values)
    .filter(([column]) => (Object.hasOwn(rule.columns!, column) ? rule.columns![column] : 'authority') === 'authority'));
}

/** Keep excluded backup rows. Only named owner-rebuild state is reset in the held transaction. */
export async function resetAccessRecoveryState(client: PoolClient, floors: AccessLeaseEpochs = { derivedGeneration: '0', discoveryRefresh: '0' }, restoredDataEpoch?: string): Promise<void> {
  const catalog = await ownerCatalog(client);
  const present = new Set([...catalog.tables.map(table => table.name), ...Object.keys(catalog.excluded)]);
  const rules = Object.entries(ACCESS_RECOVERY_CLASSIFICATION).filter(([name]) => present.has(name))
    .map(([, rule]) => rule);
  for (const rule of rules) {
    if (rule.reset) await client.query(rule.reset, rule.leaseFloor ? [floors[rule.leaseFloor]] : []);
  }
  if (restoredDataEpoch && present.has('access.derived_generation_input')) {
    // The restored graph is the backup cut at sequence zero in a new epoch.
    // Keep the original source stream, payload and progress. Only the owner
    // admission epoch maps to the graph restored at sequence zero.
    await client.query(`UPDATE access.derived_generation_input i
      SET recovery_data_epoch = $1 FROM access.derived_generation g
      WHERE g.id = i.generation_id AND g.family = 'ranking' AND g.state = 'building'
        AND i.source = 'main-graph' AND i.data_epoch <> $1
        AND i.recovery_data_epoch IS DISTINCT FROM $1`, [restoredDataEpoch]);
  }
}

async function scanAccessAuthorityTable(client: PoolClient, table: OwnerTable): Promise<RowCoverage> {
  const rule = accessRecoveryRule(table);
  if (!rule.columns && !rule.generationPayload) return scanOwnerTable(client, table);
  const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const keys = table.key.map(name => `t.${ident(name)}`);
  const omitted = Object.entries(rule.columns ?? {}).filter(([, kind]) => kind !== 'authority')
    .map(([name]) => `'${name}'`).join(', ');
  const authority = `to_jsonb(t) - ARRAY[${omitted}]::text[]`;
  const building = rule.generationColumn
    ? `EXISTS (SELECT 1 FROM access.derived_generation g WHERE g.id = t.${ident(rule.generationColumn)} AND g.state = 'building')` : undefined;
  const body = building ? `CASE WHEN ${building} THEN ${authority} ELSE to_jsonb(t) END` : rule.operationalWhen
    ? `CASE WHEN t.${ident(rule.operationalWhen.column)} = '${rule.operationalWhen.value}'
      THEN ${authority} ELSE to_jsonb(t) END` : authority;
  const select = `SELECT ${keys.map((key, index) => `${key}::text AS k${index}`).join(', ')},
    (${body})::text AS body FROM ${ident(table.schema)}.${ident(table.table)} t`;
  const hash = createHash('sha256');
  let count = 0n;
  let after: string[] | undefined;
  for (;;) {
    const predicates = [
      ...(rule.authorityWhere ? [`(${rule.authorityWhere}) IS DISTINCT FROM FALSE`] : []),
      ...(rule.generationPayload ? [`NOT ${building}`] : []),
      ...(after ? [`(${keys.join(', ')}) > (${table.keyTypes
        .map((type, index) => `$${index + 1}::${type}`).join(', ')})`] : []),
    ];
    const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
    const page: QueryResult<Record<string, string>> = await client.query(
      `${select} ${where} ORDER BY ${keys.join(', ')} LIMIT 128`, after ?? []);
    for (const row of page.rows) {
      const key = table.key.map((_, index) => row[`k${index}`]!);
      hash.update(JSON.stringify([key, row.body])).update('\n');
      count++;
      after = key;
    }
    if (page.rows.length < 128) break;
  }
  return { count: count.toString(), digest: hash.digest('hex') };
}

interface AccessOutboxRow {
  id: string;
  kind: string;
  admission_id: string | null;
  scope_id: string | null;
  principal_id: string | null;
  authority_epoch: string;
}

export async function scanAccessOutbox(client: PoolClient): Promise<{ count: string; digest: string }> {
  const digest = createHash('sha256');
  let count = 0n;
  let lastId: string | null = null;
  while (true) {
    const result: QueryResult<AccessOutboxRow> = await client.query<AccessOutboxRow>(
      `SELECT id, kind, admission_id, scope_id, principal_id, authority_epoch FROM access.outbox
       WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 1000`, [lastId]);
    for (const row of result.rows) {
      digest.update(JSON.stringify([row.id, row.kind, row.admission_id,
        row.scope_id, row.principal_id, row.authority_epoch]));
      digest.update('\n');
      count++;
      lastId = row.id;
    }
    if (result.rows.length < 1000) break;
  }
  return { count: count.toString(), digest: digest.digest('hex') };
}

/** Access tables whose rows a dedicated recovery check covers instead of the state digest. */
const ACCESS_DEDICATED = {
  'access.outbox': 'digested separately by the Access outbox coverage',
  'access.recovery_fence': 'recovery control row; capture and release check it directly',
} as const;

export interface AccessStateTables {
  state: RowCoverage;
  catalogDigest: string;
  tables: Record<string, RowCoverage>;
  excluded: Record<string, string>;
}

/**
 * Every table in the Access database, discovered from its catalog. Primary-key
 * order and canonical row text make the digest deterministic at a fixed
 * PostgreSQL major version, collation and schema.
 */
export async function scanAccessTables(client: PoolClient, profile: AccessRecoveryProfile = 'access-authority-v6'): Promise<AccessStateTables> {
  await canonicalRowText(client);
  const raw = await ownerCatalog(client, ACCESS_DEDICATED);
  const native = profile === 'access-state-v5' ? raw : accessRecoveryCatalog(raw);
  const excluded = { ...native.excluded };
  const retained = native.tables.filter(table => {
    const rule = accessRecoveryRule(table);
    if (profile === 'access-state-v5' || rule.class === 'authority' || rule.generationPayload) return true;
    excluded[table.name] = `${rule.class}: ${rule.reason}`;
    return false;
  });
  const catalog = { ...native, tables: retained, excluded };
  const tables: Record<string, RowCoverage> = {};
  for (const table of catalog.tables) tables[table.name] = profile === 'access-state-v5'
    ? await scanOwnerTable(client, table) : await scanAccessAuthorityTable(client, table);
  return { state: foldRowCoverage(profile, catalog, tables),
    catalogDigest: catalog.digest, tables, excluded: { ...catalog.excluded } };
}

/** Canonical private row coverage of every Access table except dedicated ones. */
export async function scanAccessState(client: PoolClient, profile: AccessRecoveryProfile = 'access-authority-v6'): Promise<RowCoverage> {
  return (await scanAccessTables(client, profile)).state;
}

/**
 * Stable offline digest of the complete Access outbox at one PostgreSQL snapshot.
 * A passed client keeps the caller's snapshot and locks; this does not open,
 * commit or release that transaction.
 */
export async function accessOutboxCoverage(pool: Pool,
  client?: PoolClient): Promise<{ count: string; digest: string }> {
  if (client) return scanAccessOutbox(client);
  const owned = await pool.connect();
  try {
    await owned.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const coverage = await scanAccessOutbox(owned);
    await owned.query('COMMIT');
    return coverage;
  } catch (error) {
    try { await owned.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    owned.release();
  }
}

/** Stable offline digest of the authority and admission rows at one snapshot. */
export async function accessStateCoverage(pool: Pool, client?: PoolClient, profile: AccessRecoveryProfile = 'access-authority-v6'): Promise<RowCoverage> {
  return (await accessStateTables(pool, client, profile)).state;
}

/**
 * Per-table Access coverage and its folded state digest at one snapshot.
 * A passed client keeps the caller's snapshot. Canonical row settings apply
 * for the rest of that transaction and clear when the caller commits.
 */
export async function accessStateTables(pool: Pool, client?: PoolClient, profile: AccessRecoveryProfile = 'access-authority-v6'): Promise<AccessStateTables> {
  if (client) return scanAccessTables(client, profile);
  const owned = await pool.connect();
  try {
    await owned.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const coverage = await scanAccessTables(owned, profile);
    await owned.query('COMMIT');
    return coverage;
  } catch (error) {
    try { await owned.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    owned.release();
  }
}


/** A signed table-wide floor also fences ordinary restores without native deltas. */
export async function accessLeaseEpochCoverage(pool: Pool, client?: PoolClient): Promise<AccessLeaseEpochs> {
  const sql = `SELECT coalesce((SELECT max(lease_epoch) FROM access.derived_generation), 0)::text AS derived_generation,
    coalesce((SELECT max(lease_epoch) FROM access.discovery_refresh), 0)::text AS discovery_refresh`;
  const scan = async (held: PoolClient): Promise<AccessLeaseEpochs> => {
    const row = (await held.query<{ derived_generation: string; discovery_refresh: string }>(sql)).rows[0]!;
    return { derivedGeneration: row.derived_generation, discoveryRefresh: row.discovery_refresh };
  };
  if (client) return scan(client);
  const owned = await pool.connect();
  try {
    await owned.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const epochs = await scan(owned);
    await owned.query('COMMIT');
    return epochs;
  } catch (error) {
    try { await owned.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { owned.release(); }
}
