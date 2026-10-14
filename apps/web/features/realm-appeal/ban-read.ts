import type { MainClient } from '../discover/types.ts';
import type { OperationGate } from '../api/platform-access.ts';
import { banBodyRead, type BanBodyRead } from './reading.ts';

const recordedMiss = /Unmatched recorded request|Recorded sample|Ambiguous recorded request|cannot supply/;

type Treaty<T> = {
  data: T | null;
  error: { status: number; value: unknown } | null;
  response?: unknown;
};

/** Eden hides a thrown transport inside `error` and drops `response`. A replay miss must stay a miss. */
async function fromTreaty<T>(answer: Treaty<T>, status: number): Promise<BanBodyRead> {
  if (!answer.response && answer.error) {
    const value = answer.error.value;
    if (value instanceof Error && recordedMiss.test(value.message)) throw value;
    if (value instanceof DOMException && value.name === 'AbortError') throw value;
    return { ok: false, status: answer.error.status || 0, problem: null, code: null };
  }
  if (answer.error) return banBodyRead(answer.error.status, answer.error.value);
  return banBodyRead(status, answer.data);
}

/**
 * The member's own ban through a caller-supplied client. The realm page passes
 * the request client; a recorded story passes the replay. Refusals keep the
 * problem sentence instead of collapsing to an empty page.
 * Production supplies the viewer's gate. Recorded replies omit it to replay
 * the recorded request itself, including Main's refusals.
 */
export async function readMemberBan(client: MainClient, realm: string, actingSubject: string,
  operationOpen: OperationGate = () => true): Promise<BanBodyRead> {
  const id = realm.slice(-36);
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return { ok: false, status: 0, problem: null, code: null, discrepancy: 'realm id is not a uuid' };
  }
  if (operationOpen('getV1RealmsByRealmMember-ban')) {
    const answer = await client.v1.realms({ realm: id })['member-ban'].get({ query: { actingSubject } });
    return fromTreaty(answer, 200);
  }
  return { ok: false, status: 403, problem: null, code: 'platform_closed' };
}

/** The appeal receipt on a ban, same body as the member ban, through the same client rule. */
export async function readAppealReceipt(client: MainClient, realm: string, receiptId: string,
  operationOpen: OperationGate = () => true): Promise<BanBodyRead> {
  const id = realm.slice(-36);
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f-]{36}$/.test(receiptId)) {
    return { ok: false, status: 0, problem: null, code: null, discrepancy: 'appeal path is not two uuids' };
  }
  if (operationOpen('getV1RealmsByRealmMember-receiptsByReceiptIdAppeal')) {
    const answer = await client.v1.realms({ realm: id })['member-receipts']({ receiptId }).appeal.get({
      headers: { accept: 'application/json' },
    });
    return fromTreaty(answer, 200);
  }
  return { ok: false, status: 403, problem: null, code: 'platform_closed' };
}

/** Production callers supply their viewer's gate; recorded replies also exercise refused requests. */
export async function postMemberAppeal(client: MainClient, realm: string, receiptId: string, statement: string, key: string,
  operationOpen: OperationGate = () => true) {
  const id = realm.slice(-36);
  if (operationOpen('postV1RealmsByRealmMember-receiptsByReceiptIdAppeal')) {
    return client.v1.realms({ realm: id })['member-receipts']({ receiptId }).appeal.post(
      { statement },
      { headers: { accept: 'application/json', 'idempotency-key': key } },
    );
  }
  return { data: null, error: { status: 403, value: { code: 'platform_closed' } }, response: undefined };
}
