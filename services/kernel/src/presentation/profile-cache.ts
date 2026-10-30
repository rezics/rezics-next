import {
  MAX_PROFILE_BYTES,
  platformRegistry,
  profileDigest,
  validateProfile,
  type CompositionViolation,
  type PresentationProfile,
} from '@rezics/composition';
import canonicalize from 'canonicalize';

const MAX_ENTRIES = 4;
const MAX_BYTES = 4 * MAX_PROFILE_BYTES;

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

function owned(profile: PresentationProfile): PresentationProfile {
  const snapshot = structuredClone(profile);
  freeze(snapshot);
  return snapshot;
}

/** Capture command input before any asynchronous work can observe caller mutations. */
export function profileSnapshot(value: unknown): PresentationProfile {
  return owned(validated(value));
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
    const profile = validated(body);
    if (profileDigest(profile) !== digest) throw new Error('Stored presentation profile digest mismatch');
    const hit = this.#entries.get(digest);
    if (hit) {
      this.#entries.delete(digest);
      this.#entries.set(digest, hit);
      return hit.profile;
    }

    const snapshot = owned(profile);
    const canonical = canonicalize(snapshot);
    if (canonical === undefined) return snapshot;
    const bytes = Buffer.byteLength(canonical, 'utf8');
    // Cache admission is never an additional public validation rule.
    if (bytes > MAX_BYTES) return snapshot;
    while (this.#entries.size >= MAX_ENTRIES || this.#bytes + bytes > MAX_BYTES) {
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
