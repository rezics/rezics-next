import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { createKernelRuntimeDefaults } from '../../src/composition/runtime-defaults.ts';
import { createKernelWorkModules } from '../../src/composition/work-modules.ts';
import { composeSemanticIdentityParticipants } from '../../src/composition/semantic.ts';

/** Name and identity pin for tests that inspect default registrations. The worker child must
 * decorate `startWorker`'s live `createKernelWorkModules` result, which also supplies Content ambient. */
export const KERNEL_WORK_MODULES = createKernelWorkModules(
  createDiscoveryProducerEntry,
  createKernelRuntimeDefaults,
  composeSemanticIdentityParticipants,
);
