import { memoizedValue } from '../memoized.ts';
import {
  MAX_PROFILE_BYTES,
  platformRegistry,
  profileDigest,
  validateProfile,
  type CompositionViolation,
  type PresentationProfile,
} from '@rezics/composition';
import canonicalize from 'canonicalize';
import { types } from 'node:util';

const MAX_ENTRIES = 4;
function MAX_BYTES() {
  return memoizedValue(MAX_BYTES, () => 4 * MAX_PROFILE_BYTES);
}

export class ProfileInputError extends Error {
  constructor(readonly violations: CompositionViolation[]) {
    super('Invalid presentation profile');
  }
}

function validated(value: unknown): PresentationProfile {
  const violations = validateProfile(platformRegistry, value);
  if (violations.length) throw new ProfileInputError(violations);
  return value as PresentationProfile;
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

/** Copy only profile data, without evaluating caller accessors or serialization hooks. */
function copyProfile(value: unknown): unknown {
  const ancestors = new Set<object>();
  // Canonical JSON has at least this many UTF-16 code units. The platform validator
  // still owns exact UTF-8 bytes, template/node/read bounds and violation pointers.
  let size = 0;
  const invalid = (): never => {
    throw new ProfileInputError([{ pointer: '', code: 'invalid' }]);
  };
  function charge(amount: number): void {
    size += amount;
    if (size > MAX_PROFILE_BYTES) throw new ProfileInputError([{ pointer: '', code: 'limit' }]);
  }
  function copy(input: unknown): unknown {
    if (input === null || typeof input === 'boolean') {
      charge(input === null ? 4 : input ? 4 : 5);
      return input;
    }
    if (typeof input === 'string') {
      charge(input.length + 2);
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return invalid();
      charge(JSON.stringify(input).length);
      return input;
    }
    if (typeof input !== 'object' || types.isProxy(input)) return invalid();
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (
      (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) ||
      ancestors.has(input)
    )
      return invalid();
    ancestors.add(input);
    try {
      const keys = Reflect.ownKeys(input).filter((key) => !array || key !== 'length');
      charge(2 + Math.max(0, keys.length - 1));
      if (array && keys.length !== input.length) return invalid();
      const entries: [string, unknown][] = [];
      for (const key of keys) {
        if (typeof key !== 'string') return invalid();
        const field = Object.getOwnPropertyDescriptor(input, key)!;
        if (!field.enumerable || !Object.hasOwn(field, 'value')) return invalid();
        if (array) {
          if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) return invalid();
        } else charge(key.length + 3);
        entries.push([key, copy(field.value)]);
      }
      return array ? entries.map(([, item]) => item) : Object.fromEntries(entries);
    } finally {
      ancestors.delete(input);
    }
  }
  return copy(value);
}

/** Validate exactly the detached body that will be hashed, stored or retained. */
export function profileSnapshot(value: unknown): PresentationProfile {
  let snapshot: unknown;
  try {
    snapshot = copyProfile(value);
  } catch (error) {
    if (error instanceof ProfileInputError) throw error;
    throw new ProfileInputError([{ pointer: '', code: 'invalid' }]);
  }
  const profile = validated(snapshot);
  freeze(profile);
  return profile;
}

/** Private to presentation: no database, authorization, active-head or negative state is retained. */
export class ProfileCache {
  readonly #entries = new Map<string, { profile: PresentationProfile; bytes: number }>();
  #bytes = 0;

  /** Canonical payload accounting, excluding object/Map overhead and transient read/validation work. */
  get retained(): { entries: number; bytes: number } {
    return { entries: this.#entries.size, bytes: this.#bytes };
  }

  /** The caller must supply the body read from the owning database on every invocation. */
  read(digest: string, body: unknown): PresentationProfile {
    // A digest cached from another pool cannot validate this pool's stored body.
    const profile = profileSnapshot(body);
    if (profileDigest(profile) !== digest) throw new Error('Stored presentation profile digest mismatch');
    const hit = this.#entries.get(digest);
    if (hit) {
      this.#entries.delete(digest);
      this.#entries.set(digest, hit);
      return hit.profile;
    }

    const snapshot = profile;
    const canonical = canonicalize(snapshot);
    if (canonical === undefined) return snapshot;
    const bytes = Buffer.byteLength(canonical, 'utf8');
    // Cache admission is never an additional public validation rule.
    if (bytes > MAX_BYTES()) return snapshot;
    while (this.#entries.size >= MAX_ENTRIES || this.#bytes + bytes > MAX_BYTES()) {
      const oldest = this.#entries.entries().next().value;
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes;
    }
    this.#entries.set(digest, { profile: snapshot, bytes });
    this.#bytes += bytes;
    return snapshot;
  }
}
