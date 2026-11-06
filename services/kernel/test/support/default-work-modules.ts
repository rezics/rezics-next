import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { createKernelRuntimeDefaults } from '../../src/composition/runtime-defaults.ts';
import { createKernelWorkModules } from '../../src/composition/work-modules.ts';
import { composeSemanticIdentityParticipants } from '../../src/composition/semantic.ts';

/** The production module list with the same explicit producer and Semantic composition used by the worker. */
export const KERNEL_WORK_MODULES = createKernelWorkModules(
  createDiscoveryProducerEntry,
  createKernelRuntimeDefaults,
  composeSemanticIdentityParticipants,
);
