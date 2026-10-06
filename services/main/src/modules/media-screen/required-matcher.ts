import { createHash } from 'node:crypto';

export type RequiredMatch = 'clear' | 'blocked';
export type RequiredMatcherMode =
  | { kind: 'none' }
  | { kind: 'local'; path: string }
  | { kind: 'provider' };

/** Launch has no pre-publication matching until an approved provider is enabled. */
export function requiredMatcherMode(value = 'none', production = false): RequiredMatcherMode {
  if (value === 'none' || value === 'provider') return { kind: value };
  if (value.startsWith('local:') && value.slice(6).trim()) {
    if (production) throw new Error('Production forbids local MAIN_REQUIRED_MEDIA_MATCHER');
    return { kind: 'local', path: value.slice(6) };
  }
  throw new Error('MAIN_REQUIRED_MEDIA_MATCHER must be none, local:<path>, or provider');
}

export function requiredSafetyMatcher(
  mode: RequiredMatcherMode,
): RequiredSafetyMatcher | undefined {
  if (mode.kind === 'none') return undefined;
  if (mode.kind === 'local') return new LocalRequiredSafetyMatcher(mode.path);
  // Deployment must supply an approved adapter before enabling provider mode.
  return new UnavailableRequiredSafetyMatcher();
}
/** A required provider checks exact bytes against its admitted safety corpus.
 * Failure to consult its corpus is unavailability; mode none never calls it. */
export interface RequiredSafetyMatcher {
  match(bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<RequiredMatch>;
}

export class UnavailableRequiredSafetyMatcher implements RequiredSafetyMatcher {
  match(): Promise<RequiredMatch> {
    return Promise.reject(new Error('required safety matcher is not configured'));
  }
}

/** Explicit development fixture, never production clearance. Removing or
 * corrupting its local corpus exercises a real provider outage independently
 * of the optional NSFW classifier. Fixture hashes must contain no real abuse. */
export class LocalRequiredSafetyMatcher implements RequiredSafetyMatcher {
  constructor(private readonly corpusPath: string | URL) {}
  async match(bytes: Uint8Array, _mediaType: string, signal: AbortSignal): Promise<RequiredMatch> {
    signal.throwIfAborted();
    if (!bytes.length || bytes.length > 8 * 1024 * 1024)
      throw new Error('required matcher byte bound exceeded');
    const file = Bun.file(this.corpusPath);
    if (file.size > 700_000) throw new Error('local required matcher corpus byte bound exceeded');
    const corpus: unknown = await file.json();
    if (
      !Array.isArray(corpus) ||
      corpus.length > 10_000 ||
      corpus.some((value) => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    )
      throw new Error('local required matcher corpus is invalid');
    signal.throwIfAborted();
    return corpus.includes(createHash('sha256').update(bytes).digest('hex')) ? 'blocked' : 'clear';
  }
}
