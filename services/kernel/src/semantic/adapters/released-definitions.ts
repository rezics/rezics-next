import { readRelease, activeRelease } from '../definitions.ts';
import type { ReleasedDefinitions } from '../contract/index.ts';

export type NativeReleasedDefinitions = ReleasedDefinitions<
  Parameters<typeof readRelease>[0],
  NonNullable<Awaited<ReturnType<typeof readRelease>>>,
  NonNullable<Awaited<ReturnType<typeof activeRelease>>>
>;

/** Existing native producer, including composed=false for retained accepting pins. */
export function nativeReleasedDefinitions(): NativeReleasedDefinitions {
  return { read: readRelease, active: activeRelease };
}
