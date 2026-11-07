/** Compatibility construction uses the installed native producers, including standalone preloads. */
import { requireLibraryCopyBinding } from '../domain-binding.ts';
import type { NativeCopyConfig, NativeCopyProducers } from '../copy-model.ts';

export function createNativeCopyProducers(config: NativeCopyConfig): NativeCopyProducers {
  return requireLibraryCopyBinding().producers(config);
}
