/** Standalone factory compatibility uses the same native producers that ordinary composition binds. */
import { createNativeCopyAccountAdmission } from '../../access/adapters/index.ts';
import { nativeReleasedDefinitions } from '../../semantic/adapters/index.ts';
import type { NativeCopyConfig, NativeCopyProducers } from './copies.ts';

export function createNativeCopyProducers(config: NativeCopyConfig): NativeCopyProducers {
  return { account: createNativeCopyAccountAdmission(config), definitions: nativeReleasedDefinitions() };
}
export function copyReleasedDefinitions() {
  return nativeReleasedDefinitions();
}
