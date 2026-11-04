import { type PresentationProfile } from '@rezics/composition';
import { curationFailure, type CurationFailure } from './curate';
import { admitCurationReads, type NativeReadResponse } from './curation-read-response';

export type CurationViewer = 'anonymous' | 'account';
export type CurationActionState = 'allowed' | 'denied' | 'unavailable';
export type CurationActionAdvice = { publish: CurationActionState; activate: CurationActionState };
export type CurationAdvice = CurationActionAdvice & { viewer: CurationViewer };
export type CurationOpening = {
  reader: string;
  digest: string;
  head: number;
  profile: PresentationProfile;
  advice: CurationAdvice;
};
export type CurationOpeningResult = ({ ok: true } & CurationOpening) | CurationFailure;

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const actionStates = new Set<CurationActionState>(['allowed', 'denied', 'unavailable']);
const openingByteLimit = 1024 * 1024 + 4096;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function closed(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function unavailable(): CurationFailure {
  return { ok: false, reason: 'unavailable' };
}

/** Admit the closed opening projection before it can replace a mounted reader's baseline. */
export async function admitCurationOpening(
  reader: string,
  response: NativeReadResponse,
): Promise<CurationOpeningResult> {
  if (response.status >= 400) {
    if (response.status === 404) return { ok: false, reason: 'forbidden' };
    return curationFailure(response.status, response.error?.value, response.headers);
  }

  const data = response.data;
  if (!record(data)) return unavailable();
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return unavailable();
  }
  if (new TextEncoder().encode(serialized).length > openingByteLimit) return unavailable();

  if (data.state === 'missing')
    return closed(data, ['state']) ? { ok: false, reason: 'missing-profile' } : unavailable();
  if (
    data.state !== 'active' ||
    !closed(data, ['state', 'viewer', 'digest', 'head', 'profile', 'advice']) ||
    (data.viewer !== 'account' && data.viewer !== 'anonymous') ||
    typeof data.digest !== 'string' ||
    !digestPattern.test(data.digest) ||
    typeof data.head !== 'number' ||
    !Number.isSafeInteger(data.head) ||
    data.head < 0 ||
    !record(data.advice) ||
    !closed(data.advice, ['publish', 'activate']) ||
    !actionStates.has(data.advice.publish as CurationActionState) ||
    !actionStates.has(data.advice.activate as CurationActionState)
  )
    return unavailable();

  const admitted = await admitCurationReads(
    reader,
    { status: 200, data: { digest: data.digest, head: data.head } },
    async () => ({
      status: 200,
      data: { digest: data.digest, profile: data.profile },
    }),
  );
  if (!admitted.ok || data.viewer !== 'account')
    return data.viewer === 'anonymous' ? { ok: false, reason: 'forbidden' } : unavailable();
  return {
    ok: true,
    reader: admitted.reader,
    digest: admitted.digest,
    head: admitted.head,
    profile: admitted.profile,
    advice: {
      viewer: data.viewer,
      publish: data.advice.publish as CurationActionState,
      activate: data.advice.activate as CurationActionState,
    },
  };
}

export function unavailableCurationAdvice(viewer: CurationViewer = 'account'): CurationAdvice {
  return { viewer, publish: 'unavailable', activate: 'unavailable' };
}
