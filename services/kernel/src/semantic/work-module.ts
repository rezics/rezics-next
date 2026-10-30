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
} from './events.ts';
import { stepIdentityEpochAdmission, wakeIdentityEpochAdmissionWaiters } from './identity-epoch-admission.ts';
import { runCommand } from '../command/command.ts';
import { linkProjection } from './links.ts';
import { installIdentityEpochBootstrap } from './identity-epoch-bootstrap-install.ts';
import { synchronizeAccountAgent } from '../access/account-agent-effect.ts';
import type { CloudEvent } from '../events/log.ts';
import { beginSemanticErasure, createSemanticLocatorEffect, SEMANTIC_ERASURE_SCHEDULED } from './account-erasure.ts';
import { registerSemanticErasureWork } from './account-erasure-work.ts';

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
    const scheduleErasure = registerSemanticErasureWork(context);
    context.addEffects([
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
          await stepIdentityEpochAdmission(context.pool, { jobId: data.jobId, epoch: BigInt(data.epoch) });
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
      await runCommand(context.pool, { partition: 0 }, async () => ({
        value: null,
        // Four bounded wake chains share the existing effect registration and queue limits.
        events: Array.from({ length: 4 }, (_, partition) => identityBootstrapWake(partition, 1n)),
      }));
      return startRelays(context.pool, [linkProjection(context.pool)]);
    });
  },
};
