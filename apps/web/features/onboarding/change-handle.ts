import { serviceOrigin } from '../api/origins.ts';
import { mainReadHeaders } from '../api/main-read.ts';
import { normalizedHandle } from './handle.ts';

export type ChangeHandleResult =
  | 'changed'
  | 'invalid'
  | 'conflict'
  | 'cooldown'
  | 'denied'
  | 'unavailable';
export type HandleSender = (url: URL, init: RequestInit) => Promise<Response>;

/** Main owns handle eligibility, cooldown and retired redirects. */
export async function changeHandle(
  token: string,
  agent: string,
  proposed: string,
  expectedHandle: string | null,
  key: string,
  send: HandleSender = fetch,
): Promise<ChangeHandleResult> {
  const handle = normalizedHandle(proposed);
  const id = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(agent)?.[1];
  if (!handle || !id || !/^[0-9a-f-]{36}$/.test(key)) return 'invalid';
  try {
    let expectedRevision: string | null = null;
    if (expectedHandle !== null) {
      const current = await send(
        new URL(
          `/v1/addresses/current?${new URLSearchParams({ scope: 'agent', holder: agent, actingSubject: agent })}`,
          serviceOrigin('MAIN_ORIGIN'),
        ),
        { method: 'GET', headers: await mainReadHeaders({ authorization: `Bearer ${token}` }),
          cache: 'no-store', signal: AbortSignal.timeout(10_000) },
      );
      if (!current.ok)
        return current.status === 404
          ? 'conflict'
          : [401, 403].includes(current.status)
            ? 'denied'
            : 'unavailable';
      const head = (await current.json()) as {
        holder?: string;
        revision?: string;
        key?: string;
      } | null;
      if (head?.holder !== agent || head.key !== normalizedHandle(expectedHandle) || !head.revision)
        return 'conflict';
      expectedRevision = head.revision;
    }
    const response = await send(
      new URL(
        `/v1/addresses/${expectedRevision === null ? 'claims' : 'renames'}`,
        serviceOrigin('MAIN_ORIGIN'),
      ),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({
          profile: 'name-write-v1',
          scope: 'agent',
          holder: agent,
          actingSubject: agent,
          operation: expectedRevision === null ? 'claim' : 'rename',
          name: handle,
          expectedRevision,
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.ok) {
      await response.body?.cancel();
      return 'changed';
    }
    const error = (await response.json().catch(() => null)) as { code?: string } | null;
    if (error?.code === 'name_cooldown') return 'cooldown';
    if (response.status === 409) return 'conflict';
    if (response.status === 400) return 'invalid';
    if (response.status === 403) return 'denied';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}
