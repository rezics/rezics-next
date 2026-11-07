/** Compatibility factory: every host delegates to the installed complete Library application. */
import { createCopyApplication } from './application/index.ts';
import type { NativeCopyConfig } from './copy-model.ts';
import { peekLibraryDomain, requireLibraryCopyBinding } from './domain-binding.ts';

export { CopyConflictError, CopyInvalidError } from './contract/index.ts';

export function createCopyCommands(config: NativeCopyConfig) {
  const factory = peekLibraryDomain()?.copyPorts ?? requireLibraryCopyBinding().ports;
  return createCopyApplication(factory(config));
}
