import { expect, test } from 'bun:test';
import { createKernelClient, reviewedPersonMergeInput, type ReviewedPersonRead } from '@rezics/client';
import {
  personComparison,
  readPersonComparison,
  mergePersonComparison,
  type PersonReviewPair,
} from './person-identity';
import { personCrossSourceIdentity } from '../catalogue/person-reader/model';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const originals: PersonReviewPair = [
  { subject: uuid(8), source: 'bangumi', externalId: 'person:8' },
  { subject: uuid(7), source: 'vndb', externalId: 's7' },
];
function reads(): [ReviewedPersonRead, ReviewedPersonRead] {
  return originals.map((o) => ({
    subject: { id: o.subject, type: 'schema:Person', labels: { en: 'Same credited name' }, statements: {} },
    related: {},
    viewerActions: { state: 'available', actions: [{ action: 'subject:merge', operations: ['subject.merge'] }] },
    reviewedIdentity: {
      subject: o.subject,
      source: o.source,
      externalId: o.externalId,
      revision: 9,
      securityRevision: '9007199254740993',
      claimTransactionId: uuid(88),
      property: o.source === 'bangumi' ? 'wdt:P6298' : 'wdt:P3180',
      value: o.source === 'bangumi' ? '8' : 's7',
    },
  })) as unknown as [ReviewedPersonRead, ReviewedPersonRead];
}

test('deliberate comparison seals coherent original evidence in original order without numeric security conversion', () => {
  const comparison = personComparison(originals, reads());
  if (!comparison.ok || !comparison.merge) throw new Error('Missing comparison');
  expect(reviewedPersonMergeInput(comparison.merge)).toEqual(comparison.merge);
  expect(comparison.merge.subjects).toEqual([uuid(8), uuid(7)]);
  expect(comparison.merge.expectedIdentity.endpoints[0].securityRevision).toBe('9007199254740993');
  const swapped = structuredClone(comparison.merge);
  swapped.subjects.reverse();
  expect(() => reviewedPersonMergeInput(swapped)).toThrow('Invalid reviewed Person merge');
});

test('namesakes, missing producer, Organization, redirects and denied action remain readable without confirmation', () => {
  for (const change of [
    (r: ReviewedPersonRead) => {
      delete r.reviewedIdentity;
    },
    (r: ReviewedPersonRead) => {
      r.subject.type = 'schema:Organization';
    },
    (r: ReviewedPersonRead) => {
      r.subject.id = uuid(99);
    },
    (r: ReviewedPersonRead) => {
      r.viewerActions = { state: 'unavailable' };
    },
    (r: ReviewedPersonRead) => {
      r.reviewedIdentity!.externalId = 's999';
    },
  ]) {
    const pair = reads();
    change(pair[1]);
    expect(personComparison(originals, pair)).toMatchObject({ ok: true, reads: pair, merge: null });
  }
});

test('mounted caller uses paired native observations; stale, denied and synchronous merges stay failures', async () => {
  const native = reads();
  const sent: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      sent.push(request);
      if (request.method === 'GET') {
        const source = new URL(request.url).searchParams.get('reviewIdentitySource');
        return Response.json(native[source === 'bangumi' ? 0 : 1]);
      }
      return Response.json({}, { status: sent.length === 3 ? 409 : sent.length === 4 ? 403 : 200 });
    }) as typeof fetch,
  });
  const comparison = await readPersonComparison(client, 'Bearer reviewer', originals);
  if (!comparison.ok || !comparison.merge) throw new Error('Missing native comparison');
  const command = { body: comparison.merge, key: uuid(99) };
  expect(await mergePersonComparison(client, 'Bearer reviewer', command)).toEqual({ ok: false, reason: 'stale' });
  expect(await mergePersonComparison(client, 'Bearer reviewer', command)).toEqual({ ok: false, reason: 'denied' });
  expect(await mergePersonComparison(client, 'Bearer reviewer', command)).toMatchObject({ ok: false });
  expect(sent[2]!.url).toBe('https://kernel.test/v1/subjects:merge');
  expect(await sent[2]!.clone().text()).toBe(await sent[3]!.clone().text());
  expect(await sent[2]!.clone().text()).toBe(await sent[4]!.clone().text());
  expect(sent[3]!.headers.get('idempotency-key')).toBe(JSON.stringify(command.key));
  expect(sent[4]!.headers.get('idempotency-key')).toBe(JSON.stringify(command.key));
});

test('a current Person page reflects withdrawn and conflicting identifiers even when old credits remain', () => {
  const read = reads()[0];
  const statement = (value: string) => ({ value: { type: 'value', content: value } });
  read.subject.statements = {
    'wdt:P6298': [statement('8')],
    'wdt:P3180': [statement('s7')],
    'wdt:P725': [statement(uuid(50))],
  } as unknown as ReviewedPersonRead['subject']['statements'];
  expect(personCrossSourceIdentity(read)).toBe('current');
  delete read.subject.statements['wdt:P3180'];
  expect(personCrossSourceIdentity(read)).toBe('unconfirmed');
  read.subject.statements['wdt:P3180'] = [
    statement('s7'),
    statement('s9'),
  ] as ReviewedPersonRead['subject']['statements'][string];
  expect(personCrossSourceIdentity(read)).toBe('conflicting');
});


test('the mounted Person merge returns the native receipt and an absent identity stays readable', async () => {
  const native = reads();
  const sent: Request[] = [];
  const receipt = { survivor: originals[0].subject, redirected: originals[1].subject, revision: 10 };
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      sent.push(request);
      if (request.method === 'POST') return Response.json(receipt);
      const index = new URL(request.url).searchParams.get('reviewIdentitySource') === 'bangumi' ? 0 : 1;
      return Response.json({ ...native[index], reviewedIdentity: null });
    }) as typeof fetch,
  });
  const comparison = personComparison(originals, native);
  if (!comparison.ok || !comparison.merge) throw new Error('Missing native comparison');
  const command = { body: comparison.merge, key: uuid(99) };
  expect(await mergePersonComparison(client, 'Bearer reviewer', command)).toEqual({ ok: true, admission: receipt });
  expect(await sent[0]!.json()).toEqual(command.body);
  expect(sent[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(command.key));
  expect(await readPersonComparison(client, 'Bearer reviewer', originals)).toMatchObject({ ok: true, merge: null });
});
