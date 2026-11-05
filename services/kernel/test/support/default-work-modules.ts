import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { createKernelRuntimeDefaults } from '../../src/composition/runtime-defaults.ts';
import { createKernelWorkModules } from '../../src/work/modules.ts';

/** The production module list with the same explicit producer composition used by the worker. */
export const KERNEL_WORK_MODULES = createKernelWorkModules(createDiscoveryProducerEntry, createKernelRuntimeDefaults);
