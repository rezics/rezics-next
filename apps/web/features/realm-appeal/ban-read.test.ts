import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { gateFor, type PlatformAccess, type PlatformOperationId } from '../api/platform-access.ts';
import { postMemberAppeal, readAppealReceipt, readMemberBan } from './ban-read.ts';

const realm = '00000000-0000-4000-8000-000000000001';
const receipt = '00000000-0000-4000-8000-000000000002';
const subject = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const operations = [
  'getV1RealmsByRealmMember-ban',
  'getV1RealmsByRealmMember-receiptsByReceiptIdAppeal',
  'postV1RealmsByRealmMember-receiptsByReceiptIdAppeal',
] as const satisfies readonly PlatformOperationId[];

for (const operation of operations) {
  for (const state of [
    { name: 'unavailable access', access: null, open: false },
    { name: 'closed or revoked', access: { groups: [], operations: [], generation: 'revoked' }, open: false },
    { name: 'unrelated operation', access: { groups: [], operations: ['getV1HubWorksById'], generation: 'other' }, open: false },
    { name: 'group grant', access: { groups: ['realm-appeals'], operations: [], generation: 'group' }, open: true },
    ...operations.map(granted => ({ name: `operation grant ${granted}`,
      access: { groups: [], operations: [granted], generation: granted }, open: granted === operation })),
  ] satisfies { name: string; access: PlatformAccess | null; open: boolean }[]) {
    test(`${operation}: ${state.name}`, async () => {
      const requests: Request[] = [];
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json({ code: 'forbidden', title: 'Forbidden' }, { status: 403 });
      }) as typeof fetch;
      const main = browserMainApi('https://contract.invalid', { fetcher });
      const gate = gateFor(state.access);
      if (operation === 'getV1RealmsByRealmMember-ban') {
        const read = await readMemberBan(main, realm, subject, gate);
        expect(read).toMatchObject({ ok: false, status: 403, code: state.open ? 'forbidden' : 'platform_closed' });
      } else if (operation === 'getV1RealmsByRealmMember-receiptsByReceiptIdAppeal') {
        const read = await readAppealReceipt(main, realm, receipt, gate);
        expect(read).toMatchObject({ ok: false, status: 403, code: state.open ? 'forbidden' : 'platform_closed' });
      } else {
        const answer = await postMemberAppeal(main, realm, receipt, 'Please review.', 'same-attempt', gate);
        expect(answer.error).toMatchObject({ status: 403, value: { code: state.open ? 'forbidden' : 'platform_closed' } });
      }
      expect(requests).toHaveLength(state.open ? 1 : 0);
      if (!state.open) return;
      const request = requests[0]!;
      const url = new URL(request.url);
      expect(url.pathname).toBe(operation === 'getV1RealmsByRealmMember-ban'
        ? `/api/main/v1/realms/${realm}/member-ban`
        : `/api/main/v1/realms/${realm}/member-receipts/${receipt}/appeal`);
      if (operation === 'getV1RealmsByRealmMember-ban') expect(url.searchParams.get('actingSubject')).toBe(subject);
      if (operation === 'postV1RealmsByRealmMember-receiptsByReceiptIdAppeal') {
        expect(request.method).toBe('POST');
        expect(request.headers.get('idempotency-key')).toBe('same-attempt');
        expect(await request.json()).toEqual({ statement: 'Please review.' });
      } else expect(request.method).toBe('GET');
    });
  }
}
