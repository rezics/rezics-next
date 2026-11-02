import { platformRegistry, profileDigest, validateProfile, type PresentationProfile } from '@rezics/composition';
import { curationFailure, type CurationFailure } from './curate';

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export type NativeReadResponse = {
  status: number;
  data?: unknown;
  error?: { value?: unknown } | null;
  headers?: HeadersInit | undefined;
};

export type CurationBaseline =
  | { ok: true; reader: string; digest: string; head: number; profile: PresentationProfile }
  | CurationFailure;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function admitActiveMetadata(value: unknown): { digest: string; head: number } | undefined {
  if (
    !record(value) ||
    typeof value.digest !== 'string' ||
    !DIGEST.test(value.digest) ||
    typeof value.head !== 'number' ||
    !Number.isSafeInteger(value.head) ||
    value.head < 0
  )
    return undefined;
  return { digest: value.digest, head: value.head };
}

function admitProfileEnvelope(
  requestedDigest: string,
  value: unknown,
): { digest: string; profile: PresentationProfile } | undefined {
  if (
    !DIGEST.test(requestedDigest) ||
    !record(value) ||
    value.digest !== requestedDigest ||
    validateProfile(platformRegistry, value.profile).length > 0
  )
    return undefined;
  const profile = value.profile as PresentationProfile;
  if (profileDigest(profile) !== requestedDigest) return undefined;
  return { digest: requestedDigest, profile };
}

/** Admit the two native read envelopes before a profile becomes an editable baseline. */
export async function admitCurationReads(
  reader: string,
  active: NativeReadResponse,
  loadProfile: (digest: string) => Promise<NativeReadResponse>,
): Promise<CurationBaseline> {
  if (active.status >= 400) return curationFailure(active.status, active.error?.value, active.headers);
  const metadata = admitActiveMetadata(active.data);
  if (!metadata) return { ok: false, reason: 'unavailable' };
  const result = await loadProfile(metadata.digest);
  if (result.status >= 400) return curationFailure(result.status, result.error?.value, result.headers);
  const admitted = admitProfileEnvelope(metadata.digest, result.data);
  if (!admitted) return { ok: false, reason: 'unavailable' };
  return { ok: true, reader, digest: admitted.digest, head: metadata.head, profile: admitted.profile };
}
