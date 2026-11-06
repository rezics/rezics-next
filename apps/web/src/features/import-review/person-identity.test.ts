import { expect, test } from 'bun:test';
import { createKernelClient, reviewedPersonMergeInput, type ReviewedPersonRead } from '@rezics/client';
import {
  personComparison,
  readPersonComparison,
  readPersonPublication,
  personReviewPairInput,
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

test('a merged original is compared through its survivor exactly once and cannot forge a merge', async () => {
  const native = reads();
  const seen: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const url = new URL(new Request(input, init).url);
      seen.push(url.pathname);
      if (url.pathname.endsWith(uuid(8)))
        return Response.json({ redirect: { from: uuid(8), to: uuid(7) } }, { status: 308 });
      return Response.json(native[1]);
    }) as typeof fetch,
  });
  expect(await readPersonComparison(client, 'Bearer reviewer', originals)).toMatchObject({
    ok: true,
    merge: null,
    reads: [{ subject: { id: uuid(7) } }, { subject: { id: uuid(7) } }],
  });
  expect(seen).toHaveLength(3);
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
  read.subject.statements['wdt:P3180']![1]!.rank = 'deprecated';
  expect(personCrossSourceIdentity(read)).toBe('current');
});

test('original showcase claims enable admission; publication waits for the native job and two independent public reads', async () => {
  const pair = personReviewPairInput(originals.map((o) => ({ ...o, source: `${o.source}_cross_media` })));
  const native = reads();
  native.forEach((read, index) => {
    read.reviewedIdentity!.source = pair[index]!.source;
  });
  const seen: Request[] = [];
  let done = false;
  let withdrawn = false;
  let ineligible = false;
  const operation = uuid(100);
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      const url = new URL(request.url);
      if (url.pathname.includes('subjectIdentityOperations'))
        return Response.json({
          operation: done
            ? { id: operation, done: true, result: { survivor: uuid(7), redirected: uuid(8), revision: 10 } }
            : { id: operation, done: false },
        });
      if (request.method === 'POST')
        return Response.json(
          { operation: { id: operation } },
          { status: 202, headers: { Location: `/v1/subjectIdentityOperations/${operation}` } },
        );
      if (url.searchParams.has('reviewIdentitySource')) {
        const read = structuredClone(native[url.pathname.endsWith(uuid(8)) ? 0 : 1]!);
        if (ineligible) read.reviewedIdentity = null;
        return Response.json(read);
      }
      const read = structuredClone(native[1]);
      delete read.reviewedIdentity;
      read.subject.statements = {
        'wdt:P6298': [{ value: { type: 'value', content: '8' } }],
        ...(!withdrawn ? { 'wdt:P3180': [{ value: { type: 'value', content: 's7' } }] } : {}),
      } as unknown as ReviewedPersonRead['subject']['statements'];
      return Response.json(read);
    }) as typeof fetch,
  });
  const comparison = await readPersonComparison(client, 'Bearer reviewer', pair);
  if (!comparison.ok || !comparison.merge) throw new Error('Missing showcase comparison');
  const command = { body: comparison.merge, key: uuid(99) };
  const location = `/v1/subjectIdentityOperations/${operation}`;
  expect(await mergePersonComparison(client, 'Bearer reviewer', command)).toEqual({
    ok: true,
    admission: { operation: { id: operation } },
    location,
  });
  expect(await readPersonPublication(client, 'Bearer reviewer', { command, operation, location })).toEqual({
    ok: true,
    state: 'pending',
  });
  expect(seen).toHaveLength(4);
  done = true;
  expect(await readPersonPublication(client, 'Bearer reviewer', { command, operation, location })).toMatchObject({
    ok: true,
    state: 'published',
    read: { subject: { id: uuid(7) } },
  });
  expect(seen.slice(-2).map((request) => new URL(request.url).pathname)).toEqual(
    pair.map((o) => `/v1/subjects/${o.subject}`),
  );
  expect(seen.slice(-2).every((request) => !request.headers.has('authorization'))).toBe(true);
  withdrawn = true;
  expect(await readPersonPublication(client, 'Bearer reviewer', { command, operation, location })).toEqual({
    ok: true,
    state: 'unconfirmed',
  });
  ineligible = true;
  expect(await readPersonComparison(client, 'Bearer reviewer', pair)).toMatchObject({ ok: true, merge: null });
});

test('publication reads a merged original through its body-named survivor exactly once', async () => {
  const comparison = personComparison(originals, reads());
  if (!comparison.ok || !comparison.merge) throw new Error('Missing comparison');
  const command = { body: comparison.merge, key: uuid(99) };
  const survivor = {
    subject: {
      id: uuid(7),
      type: 'schema:Person',
      labels: {},
      statements: {
        'wdt:P6298': [{ value: { type: 'value', content: '8' } }],
        'wdt:P3180': [{ value: { type: 'value', content: 's7' } }],
      },
    },
    related: {},
  };
  const seen: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const url = new URL(new Request(input, init).url);
      seen.push(url.pathname);
      if (url.pathname.includes('subjectIdentityOperations'))
        return Response.json({
          operation: { id: uuid(100), done: true, result: { survivor: uuid(7), redirected: uuid(8), revision: 10 } },
        });
      if (url.pathname.endsWith(uuid(8)))
        return Response.json({ redirect: { from: uuid(8), to: uuid(7) } }, { status: 308 });
      return Response.json(survivor);
    }) as typeof fetch,
  });
  expect(
    await readPersonPublication(client, 'Bearer reviewer', {
      command,
      operation: uuid(100),
      location: `/v1/subjectIdentityOperations/${uuid(100)}`,
    }),
  ).toMatchObject({
    ok: true,
    state: 'published',
    read: { subject: { id: uuid(7) } },
  });
  expect(seen).toHaveLength(4);
});

test('HTTP 202 identity admission without a matching Location is not a current job', async () => {
  const comparison = personComparison(originals, reads());
  if (!comparison.ok || !comparison.merge) throw new Error('Missing comparison');
  const command = { body: comparison.merge, key: uuid(99) };
  const operation = uuid(100);
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') return Response.json({ operation: { id: operation } }, { status: 202 });
      return Response.json({ operation: { id: operation, done: false } });
    }) as typeof fetch,
  });
  await expect(mergePersonComparison(client, 'Bearer reviewer', command)).rejects.toThrow(
    'Invalid native identity admission',
  );
});
