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

/** Native relation projection shares the worker pool and registered service lifecycle. */
export const semanticWorkModule: WorkModule = {
  name: 'semantic',
  register(context) {
    context.addEffects([
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
        events: [identityBootstrapWake(0, 1n)],
      }));
      return startRelays(context.pool, [linkProjection(context.pool)]);
    });
  },
};
