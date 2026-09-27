import { serviceOrigin } from '../api/origins.ts';
import { normalizedHandle } from './handle.ts';

export type ChangeHandleResult = 'changed' | 'invalid' | 'conflict' | 'cooldown' | 'denied' | 'unavailable';
export type HandleSender = (url: URL, init: RequestInit) => Promise<Response>;

/** Main owns handle eligibility, cooldown and retired redirects. */
export async function changeHandle(token: string, agent: string, proposed: string,
  expectedHandle: string | null, key: string, send: HandleSender = fetch): Promise<ChangeHandleResult> {
  const handle = normalizedHandle(proposed);
  const id = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/.exec(agent)?.[1];
  if (!handle || !id || !/^[0-9a-f-]{36}$/.test(key)) return 'invalid';
  try {
    const response = await send(new URL(`/v1/agents/${id}/handle`, serviceOrigin('MAIN_ORIGIN')), {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify({ profile: 'agent-handle-v1', handle, expectedHandle }),
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) { await response.body?.cancel(); return 'changed'; }
    const error = await response.json().catch(() => null) as { code?: string } | null;
    if (error?.code === 'agent_handle_cooldown') return 'cooldown';
    if (response.status === 409) return 'conflict';
    if (response.status === 400) return 'invalid';
    if (response.status === 403) return 'denied';
    return 'unavailable';
  } catch { return 'unavailable'; }
}
