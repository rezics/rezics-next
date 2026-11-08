import { readRelease, activeRelease } from '../definition-release-read.ts';
import type { ReleasedDefinitions } from '../contract/index.ts';
export type NativeReleasedDefinitions = ReleasedDefinitions<Parameters<typeof readRelease>[0], NonNullable<Awaited<ReturnType<typeof readRelease>>>, NonNullable<Awaited<ReturnType<typeof activeRelease>>>>;
/** Existing native producer, including composed=false for retained accepting pins. */
export declare function nativeReleasedDefinitions(): NativeReleasedDefinitions;
