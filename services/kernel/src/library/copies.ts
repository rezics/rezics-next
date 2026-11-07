/** Compatibility factory: HTTP and native callers use the complete composed Library application. */
import { createCopyApplication } from './application/index.ts';
import { createNativeCopyPorts, type NativeCopyConfig } from './adapters/copies.ts';
import { createNativeCopyProducers } from './adapters/copy-producers.ts';
import { peekLibraryDomain } from './domain-binding.ts';

export { CopyConflictError, CopyInvalidError } from './contract/index.ts';

export function createCopyCommands(config: NativeCopyConfig) {
  const ports =
    peekLibraryDomain()?.copyPorts?.(config) ?? createNativeCopyPorts(config, createNativeCopyProducers(config));
  return createCopyApplication(ports);
}
