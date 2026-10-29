import type { LibraryProfilePin } from './profile.ts';

/** Decode private stored provenance without resolving current definitions. */
export function decodeLibraryProfilePin(value: unknown): LibraryProfilePin | null {
  if (value === null) return null;
  const invalid = (): never => {
    throw new Error('Invalid stored library profile pin');
  };
  if (typeof value !== 'object' || Array.isArray(value)) return invalid();
  const keys = ['provenance', 'releaseDigest', 'acceptingType', 'profileId'];
  if (Object.keys(value).length !== 4 || !keys.every((key) => Object.hasOwn(value, key))) return invalid();
  if (!('provenance' in value && 'releaseDigest' in value && 'acceptingType' in value && 'profileId' in value))
    return invalid();
  const { provenance, releaseDigest, acceptingType, profileId } = value;
  if (typeof releaseDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(releaseDigest)) return invalid();
  if (provenance === 'profile') {
    if (typeof acceptingType !== 'string' || acceptingType.length === 0) return invalid();
    if (typeof profileId !== 'string' || profileId.length === 0) return invalid();
    return { provenance, releaseDigest, acceptingType, profileId };
  }
  if (provenance === 'legacy' && profileId === 'legacy-fixed-v1') {
    if (acceptingType !== null && (typeof acceptingType !== 'string' || acceptingType.length === 0)) return invalid();
    return { provenance, releaseDigest, acceptingType, profileId };
  }
  return invalid();
}
