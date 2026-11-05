import { registerDefinitionCatalogueWork } from './register.ts';
import { contextDirectoryEffect, populateContextDirectory, registerContextDirectoryWork } from './context-directory.ts';
import { startRelays } from '../events/relays.ts';
import type { WorkModule } from '../work/registry.ts';
import { runIdentityEpochBootstrapBatch, identityBootstrapWake } from './identity-epoch-bootstrap.ts';
import {
  IDENTITY_EPOCH_BOOTSTRAP,
  IDENTITY_EPOCH_BOOTSTRAP_SCHEDULED,
  IDENTITY_EPOCH_ADMITTED,
  IDENTITY_EPOCH_HOME_AVAILABLE,
  SUBJECT_MERGED,
  SUBJECT_REVISED,
  LINKS_MOVING,
} from '../events/contracts/semantic.ts';
import { wakeIdentityEpochAdmissionWaiters } from './identity-epoch-admission.ts';
import { registerIdentityEpochCoordinator, resumeIdentityEpochJob } from './identity-epoch-coordinator.ts';
import { runCommand } from '../command/command.ts';
import { createAccess } from '../access/index.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import roles from '../access/resource-roles.json';
import { createSubjectPagePublication } from './subject-page-publication.ts';
import { createSubjectPagePublicationRelay } from './subject-page-publication-relay.ts';
import { registerSubjectPagePublicationWork } from './publication-work.ts';
import { linkProjection } from './links.ts';
import { installIdentityEpochBootstrap } from './identity-epoch-bootstrap-install.ts';
import { synchronizeAccountAgent } from '../access/account-agent-effect.ts';
import type { CloudEvent } from '../events/log.ts';
import { beginSemanticErasure, createSemanticLocatorEffect, SEMANTIC_ERASURE_SCHEDULED } from './account-erasure.ts';
import { registerSemanticErasureWork } from './account-erasure-work.ts';

import { registerRecordRetentionWork } from './retention-work.ts';
import { registerIdentityScopedObservationWork } from './identity-scoped-observations.ts';
import { providerReviewProjection, registerProviderReviewWork } from './provider-review-queue.ts';

const ACCOUNT_TOMBSTONED = 'com.rezics.access.account-tombstoned.v1';

/** Synchronize the account-agent label and close the real local participant fence from the native tombstone.
 * The scheduled local workflow performs owned cleanup; shared custody and final acknowledgement remain separate.
 */
export function createSemanticErasureEffect(pool: Parameters<typeof synchronizeAccountAgent>[0]) {
  return {
    name: 'semantic_erasure',
    types: [ACCOUNT_TOMBSTONED],
    async run(event: CloudEvent) {
      const accountId = (event.data as { accountId?: unknown } | null)?.accountId;
      if (typeof accountId !== 'string') throw new TypeError('Invalid account tombstone event');
      await synchronizeAccountAgent(pool, accountId);
      await beginSemanticErasure(pool, accountId);
    },
  };
}

/** Native relation projection shares the worker pool and registered service lifecycle. */
export const semanticWorkModule: WorkModule = {
  name: 'semantic',
  async register(context) {
    // Establish the writer cut before DBOS can resume an old bootstrap delivery.
    await installIdentityEpochBootstrap(context.pool);
    const config = readMembershipWorkConfig(context.env);
    const names = new Set(Object.values(roles.roles).flat());
    const actions = new Map(
      [...names].map((action) => [
        action,
        { anonymous: action === 'subject:read' || action === 'definitions:read' || action === 'presentation:read' },
      ]),
    );
    const access = createAccess({ actions, auth: config.auth, clock: context.clock });
    const binding = { pool: context.pool, access, clock: context.clock, routeKey: config.routeKey };
    const publication = createSubjectPagePublication(binding);
    const relay = createSubjectPagePublicationRelay(binding);
    registerSubjectPagePublicationWork(context, publication);
    registerDefinitionCatalogueWork(context);
    const scheduleErasure = registerSemanticErasureWork(context);
    await registerRecordRetentionWork(context);
    await registerIdentityScopedObservationWork(context);
    registerProviderReviewWork(context);
    registerIdentityEpochCoordinator(context);
    await registerContextDirectoryWork(context);
    context.addEffects([
      contextDirectoryEffect(context.pool, context.clock),
      createSemanticErasureEffect(context.pool),
      createSemanticLocatorEffect(context.pool),
      {
        name: 'semantic_erasure_local',
        types: [SEMANTIC_ERASURE_SCHEDULED],
        async run(event) {
          const accountId = (event.data as { accountId: string }).accountId;
          await scheduleErasure(accountId);
        },
      },
      {
        name: 'identity_epoch_admission_wake',
        types: [IDENTITY_EPOCH_HOME_AVAILABLE],
        run: async (event) => {
          const data = event.data as { partition: number; after: string };
          await wakeIdentityEpochAdmissionWaiters(context.pool, data.partition, data.after);
        },
      },
      {
        name: 'identity_epoch_admission',
        types: [IDENTITY_EPOCH_ADMITTED],
        run: async (event) => {
          const data = event.data as { jobId: string; epoch: string };
          await resumeIdentityEpochJob(context.pool, { jobId: data.jobId, epoch: BigInt(data.epoch) });
        },
      },
      {
        name: 'identity_epoch_bootstrap',
        types: [
          IDENTITY_EPOCH_BOOTSTRAP,
          IDENTITY_EPOCH_BOOTSTRAP_SCHEDULED,
          SUBJECT_MERGED,
          SUBJECT_REVISED,
          LINKS_MOVING,
          'com.rezics.subject.created.v1',
        ],
        run: async () => {
          await runIdentityEpochBootstrapBatch(context.pool);
        },
      },
    ]);
    context.addService(async () => {
      await populateContextDirectory(context.pool, context.clock);
      await runCommand(context.pool, { partition: 0 }, async () => ({
        value: null,
        // Four bounded wake chains share the existing effect registration and queue limits.
        events: Array.from({ length: 4 }, (_, partition) => identityBootstrapWake(partition, 1n)),
      }));
      return startRelays(context.pool, [linkProjection(context.pool), providerReviewProjection(context.pool), relay]);
    });
  },
};
