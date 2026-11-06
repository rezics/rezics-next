import type { ContentAmbient } from '../contract/index.ts';

/** Native time, UUID, network and clock. Composition may override any operand. */
export function createNativeContentAmbient(overrides: Partial<ContentAmbient> = {}): ContentAmbient {
  return Object.freeze({
    clock: overrides.clock ?? (() => new Date()),
    now: overrides.now ?? (() => Date.now()),
    id: overrides.id ?? (() => Bun.randomUUIDv7()),
    fetch: overrides.fetch ?? ((request) => globalThis.fetch(request)),
  });
}
