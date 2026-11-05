import { routedId } from '../resource-access/data';

/** Local consumer contract for the native private GET, independent of generated-client readiness. */
export type ErasureStatus = {
  accountId: string;
  state: 'pending' | 'retention-outstanding' | 'complete';
  at: string;
  completedAt: string | null;
  pendingParticipants: string[];
  retentionOutstanding: boolean;
  lateItems: boolean;
  effectsFrontier: boolean;
};
export type Selection = { accountId: string; viewerId: string };
export type Page =
  | { status: 'ready'; viewerId: string; value: ErasureStatus }
  | { status: 'loading' | 'signed-out' | 'denied' | 'missing' | 'unavailable' };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function parseSelection(value: unknown): Selection {
  if (!object(value) || Object.keys(value).length !== 2 || !routedId(value.accountId) || !routedId(value.viewerId))
    throw new Error('Invalid erasure selection');
  return { accountId: value.accountId, viewerId: value.viewerId };
}
const fields = [
  'accountId',
  'state',
  'at',
  'completedAt',
  'pendingParticipants',
  'retentionOutstanding',
  'lateItems',
  'effectsFrontier',
];
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** Fail closed on omitted proof, private additions, inconsistent terminal states and unbounded labels. */
export function parseStatus(value: unknown, accountId: string): ErasureStatus | null {
  if (
    !object(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    value.accountId !== accountId ||
    !routedId(value.accountId) ||
    !['pending', 'retention-outstanding', 'complete'].includes(value.state as string) ||
    !timestamp(value.at) ||
    (value.completedAt !== null && !timestamp(value.completedAt)) ||
    !Array.isArray(value.pendingParticipants) ||
    value.pendingParticipants.length > 64 ||
    !value.pendingParticipants.every((name) => typeof name === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(name)) ||
    new Set(value.pendingParticipants).size !== value.pendingParticipants.length ||
    typeof value.retentionOutstanding !== 'boolean' ||
    typeof value.lateItems !== 'boolean' ||
    typeof value.effectsFrontier !== 'boolean'
  )
    return null;
  if (value.completedAt !== null && value.completedAt < value.at) return null;
  if (value.state === 'pending' && value.completedAt !== null) return null;
  if (
    value.state !== 'pending' &&
    (value.completedAt === null || value.pendingParticipants.length !== 0 || value.lateItems || value.effectsFrontier)
  )
    return null;
  if (value.state === 'complete' && value.retentionOutstanding) return null;
  if (value.state === 'retention-outstanding' && !value.retentionOutstanding) return null;
  return {
    accountId: value.accountId,
    state: value.state as ErasureStatus['state'],
    at: value.at,
    completedAt: value.completedAt as string | null,
    pendingParticipants: [...value.pendingParticipants] as string[],
    retentionOutstanding: value.retentionOutstanding,
    lateItems: value.lateItems,
    effectsFrontier: value.effectsFrontier,
  };
}

/** Real transport only: no profile read, discovery, fixture client, body, or synthetic authority. */
export async function readErasureStatus(
  origin: string | undefined,
  authorization: string,
  selection: Selection,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Page> {
  try {
    parseSelection(selection);
    if (!origin || !authorization) return { status: 'unavailable' };
    const url = new URL(`/v1/accounts/${selection.accountId}/erasureStatus`, origin);
    const response = await fetcher(url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      headers: { authorization, accept: 'application/json', 'cache-control': 'no-store' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return {
        status:
          response.status === 401
            ? 'signed-out'
            : response.status === 403
              ? 'denied'
              : response.status === 404
                ? 'missing'
                : 'unavailable',
      };
    }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      return { status: 'unavailable' };
    }
    // Bound bytes as well as participant count before parsing. Never forward native error bodies.
    const reader = response.body?.getReader();
    if (!reader) return { status: 'unavailable' };
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) {
        await reader.cancel();
        return { status: 'unavailable' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = parseStatus(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), selection.accountId);
    return value ? { status: 'ready', viewerId: selection.viewerId, value } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}
