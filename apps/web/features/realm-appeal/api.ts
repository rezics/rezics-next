import { BFF_PREFIX } from '../api/browser.ts';
import { parseBanReading, type BanReading } from './reading.ts';

export type AppealSubmit =
  | { kind: 'sent'; reading: BanReading }
  | { kind: 'invalid' }
  | { kind: 'failed'; reuseKey: boolean };

const realmId = (realm: string) => encodeURIComponent(realm.slice(-36));

async function problemCode(response: Response): Promise<string | null> {
  const body = await response.json().catch(() => null) as { code?: unknown } | null;
  return body && typeof body.code === 'string' ? body.code : null;
}

/** Appeal through the BFF. The receipt comes from the member's own ban read. */
export function appealClient(realm: string, receiptId: string, fetchImpl: typeof fetch = fetch): {
  submit(statement: string, key: string): Promise<AppealSubmit>;
} {
  const path = `${BFF_PREFIX}/v1/realms/${realmId(realm)}/member-receipts/${encodeURIComponent(receiptId)}/appeal`;
  const headers = () => {
    const result = new Headers({ accept: 'application/json' });
    if (typeof window !== 'undefined') result.set('x-rezics-page-url', window.location.href);
    return result;
  };
  async function read(): Promise<BanReading | null> {
    const response = await fetchImpl(path, { headers: headers(), credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return parseBanReading(await response.json());
  }
  return {
    async submit(statement, key) {
      const outgoing = headers();
      outgoing.set('content-type', 'application/json');
      outgoing.set('idempotency-key', key);
      const response = await fetchImpl(path, {
        method: 'POST', headers: outgoing, credentials: 'same-origin', cache: 'no-store',
        body: JSON.stringify({ statement }),
      });
      if (response.ok) {
        await response.body?.cancel();
        const reading = await read();
        return reading ? { kind: 'sent', reading } : { kind: 'failed', reuseKey: true };
      }
      const code = await problemCode(response);
      if (code === 'appeal_already_open' || code === 'stale_appeal') {
        const reading = await read();
        if (reading && reading.appeal.state !== 'none') return { kind: 'sent', reading };
      }
      if (code === 'invalid_appeal') return { kind: 'invalid' };
      const reuseKey = code !== 'idempotency_conflict' && code !== 'invalid_idempotency_key';
      return { kind: 'failed', reuseKey };
    },
  };
}
