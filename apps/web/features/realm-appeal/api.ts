import { browserMainApi } from '../api/browser.ts';
import { gateFor, platformClosed, type OperationGate } from '../api/platform-access.ts';
import { postMemberAppeal, readAppealReceipt } from './ban-read.ts';
import { banProblem, type BanProblem, type BanReading } from './reading.ts';

export type AppealSubmit =
  | { kind: 'sent'; reading: BanReading }
  | { kind: 'invalid' }
  | { kind: 'closed' }
  | { kind: 'failed'; reuseKey: boolean; problem?: BanProblem };

function problemCode(body: unknown): string | null {
  return body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : null;
}

function failed(reuseKey: boolean, status: number, value: unknown): AppealSubmit {
  const problem = banProblem(status, value);
  return problem ? { kind: 'failed', reuseKey, problem } : { kind: 'failed', reuseKey };
}

/** Appeal through the BFF. The receipt comes from the member's own ban read. */
export function appealClient(realm: string, receiptId: string, fetchImpl: typeof fetch = fetch,
  operationOpen: OperationGate = gateFor(null)): {
  submit(statement: string, key: string): Promise<AppealSubmit>;
} {
  const main = browserMainApi(typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
    { fetcher: fetchImpl, cache: 'no-store' });
  async function read(): Promise<BanReading | null | 'closed'> {
    if (operationOpen('getV1RealmsByRealmMember-receiptsByReceiptIdAppeal')) {
      const read = await readAppealReceipt(main, realm, receiptId, operationOpen);
      if (!read.ok) {
        if (read.status === 403 && read.code === 'platform_closed') return 'closed';
        return null;
      }
      return read.reading;
    }
    return 'closed';
  }
  return {
    async submit(statement, key) {
      if (operationOpen('postV1RealmsByRealmMember-receiptsByReceiptIdAppeal')) {
        if (operationOpen('getV1RealmsByRealmMember-receiptsByReceiptIdAppeal')) {
          const { error } = await postMemberAppeal(main, realm, receiptId, statement, key, operationOpen);
          if (!error) {
            const reading = await read();
            if (reading === 'closed') return { kind: 'closed' };
            return reading ? { kind: 'sent', reading } : { kind: 'failed', reuseKey: true };
          }
          const code = problemCode(error.value);
          if (platformClosed(error.status, error.value)) return { kind: 'closed' };
          if (code === 'appeal_already_open' || code === 'stale_appeal') {
            const reading = await read();
            if (reading === 'closed') return { kind: 'closed' };
            if (reading && reading.appeal.state !== 'none') return { kind: 'sent', reading };
          }
          if (code === 'invalid_appeal') return { kind: 'invalid' };
          const reuseKey = code !== 'idempotency_conflict' && code !== 'invalid_idempotency_key';
          return failed(reuseKey, error.status, error.value);
        }
      }
      return { kind: 'closed' };
    },
  };
}
