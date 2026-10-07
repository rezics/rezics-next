import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import { privateDraftUnit } from '../src/modules/contribution/private-projection.ts';
import { PRIVATE_SEARCH_FINAL_FUSEKI_CALLS, PRIVATE_SEARCH_FUSEKI_CALLS,
  PrivateSearchUnavailable, prepareAdmittedPrivateContributionPhrase,
  queryPrivateContributionPhrase, type PrivateSearchAccess }
  from '../src/modules/contribution/search-private.ts';
import { author, body, contribution, fixture, revision, settlement }
  from './search-private-fixture.ts';

const principal = { issuer: 'https://account.test', subject: 'reader' };
const leaseId = '00000000-0000-4000-8000-000000000018';
const input = { contribution, phrase: 'nebula phrase' };

/** Instrument the existing native/object fixture without replacing any owner
 * module or adding a source generator. Health calls are the three position gates. */
function observeHealth(run: ReturnType<typeof fixture>, uncertainAt = 0) {
  const healthy = run.fuseki.commandHealth.bind(run.fuseki);
  let reads = 0;
  run.fuseki.commandHealth = async () => ({ ...await healthy(),
    textIndexUncertain: ++reads === uncertainAt });
  return { get reads() { return reads; },
    get calls() { return reads + run.fuseki.queries.length; } };
}

function reader(operations: string[], denied = false, closedAt?: 'begin' | 'arm'): PrivateSearchAccess {
  return {
    admitContributionSearchRead: async () => {
      operations.push('admit');
      if (denied) throw new AdmissionDenied('no private Contribution grant');
      return { id: leaseId };
    },
    beginContributionSearchDelivery: async () => {
      operations.push('begin');
      if (closedAt === 'begin') throw new AdmissionDenied('Contribution read scope closed');
      return { id: leaseId };
    },
    armContributionSearchSend: async () => {
      operations.push('arm');
      if (closedAt === 'arm') throw new AdmissionDenied('Contribution read scope closed');
    },
    finishContributionSearchRead: async (_id: string, outcome: string) => { operations.push(outcome); },
  } as unknown as PrivateSearchAccess;
}

/** Each native position observes a later diagnostic Main sequence, while the
 * exact Contribution source and private index tokens remain unchanged. */
function advanceDiagnosticSequence(run: ReturnType<typeof fixture>) {
  const query = run.fuseki.query.bind(run.fuseki);
  run.fuseki.query = async sparql => {
    const result = await query(sparql);
    if (!sparql.includes('SELECT ?head ?sequence ?generation')) return result;
    return { results: { bindings: (result.results?.bindings ?? []).map(row => ({ ...row,
      sequence: { type: 'literal', value: String(6 + run.fuseki.reads) } })) } };
  };
}

type LocalFault = 'source head' | 'source withdrawal' | 'data epoch' | 'restore hold'
  | 'native instance' | 'index generation' | 'private writer epoch';

/** Change one existing local fence at preparation's final position or the
 * after-arm position. A hold or different dataset epoch makes its guarded
 * position query empty; it does not fabricate a new source token. */
function changeLocalFence(run: ReturnType<typeof fixture>, health: ReturnType<typeof observeHealth>,
  at: number, fault: LocalFault) {
  const query = run.fuseki.query.bind(run.fuseki);
  run.fuseki.query = async sparql => {
    const result = await query(sparql);
    if (!sparql.includes('SELECT ?head ?sequence ?generation') || run.fuseki.reads < at) return result;
    if (fault === 'source withdrawal' || fault === 'data epoch' || fault === 'restore hold') {
      if (fault === 'source withdrawal') expect(sparql).toContain('rv:draftHead ?head');
      if (fault === 'data epoch') expect(sparql).toContain(`rv:dataEpoch "${run.env.lineage.dataEpoch}"`);
      if (fault === 'restore hold') expect(sparql).toContain('rv:restoreHold true');
      return { results: { bindings: [] } };
    }
    return { results: { bindings: (result.results?.bindings ?? []).map(row => ({ ...row,
      ...(fault === 'source head' ? { head: { type: 'uri', value: author } } : {}),
      ...(fault === 'index generation' ? { generation: { type: 'uri',
        value: 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000020' } } : {}),
    })) } };
  };
  const healthy = run.fuseki.commandHealth.bind(run.fuseki);
  run.fuseki.commandHealth = async () => {
    const result = await healthy();
    return { ...result,
      instanceId: fault === 'native instance' && health.reads >= at
        ? '22222222-2222-4222-8222-222222222222' : result.instanceId,
      privateSearchWriteEpoch: fault === 'private writer epoch' && health.reads >= at
        ? '2' : result.privateSearchWriteEpoch };
  };
}

test('SEARCH11: initially uncertain Contribution index aborts before source, object, projection or text access', async () => {
  const run = fixture();
  const health = observeHealth(run, 1);
  const operations: string[] = [];
  // Exact custody is deliberately inaccessible; uncertainty must win before
  // an anchor lookup could expose its manifest or reach object bytes.
  run.env.objectDirectory = join(run.env.objectDirectory, 'unavailable-exact-custody');
  try {
    const error = await prepareAdmittedPrivateContributionPhrase(run.env, reader(operations),
      settlement(operations), principal, author, input)
      .then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(PrivateSearchUnavailable);
    expect((error as Error).message).toMatch(/uncertain/i);
    expect(operations).toEqual(['admit', 'aborted']);
    expect(health.reads).toBe(1);
    expect(run.fuseki.reads).toBe(0);
    expect(run.fuseki.queries).toEqual([]);
  } finally { run.cleanup(); }
});

test('SEARCH11: Contribution uncertainty at the post-match position aborts preparation', async () => {
  const run = fixture();
  const health = observeHealth(run, 2);
  const operations: string[] = [];
  try {
    const error = await prepareAdmittedPrivateContributionPhrase(run.env, reader(operations),
      settlement(operations), principal, author, input)
      .then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(PrivateSearchUnavailable);
    expect((error as Error).message).toMatch(/uncertain/i);
    expect(operations).toEqual(['admit', 'aborted']);
    expect(health.reads).toBe(2);
    expect(run.fuseki.reads).toBe(1);
    expect(run.fuseki.queries.filter(query => query.includes('text:query'))).toHaveLength(2);
    expect(health.calls).toBeLessThanOrEqual(PRIVATE_SEARCH_FUSEKI_CALLS);
  } finally { run.cleanup(); }
});

test('SEARCH12: Contribution uncertainty after send arm withholds the match without a frame', async () => {
  const run = fixture();
  const health = observeHealth(run, 3);
  const operations: string[] = [];
  try {
    const session = await prepareAdmittedPrivateContributionPhrase(run.env, reader(operations),
      settlement(operations), principal, author, input);
    const prepareCalls = health.calls;
    const frames: string[] = [];
    await expect(session.send(frame => { frames.push(frame); return 1; }))
      .rejects.toBeInstanceOf(PrivateSearchUnavailable);
    expect(frames).toEqual([]);
    expect(session.offered).toBe(false);
    expect(operations).toEqual(['admit', 'begin', 'arm', 'withheld']);
    expect(health.reads).toBe(3);
    expect(run.fuseki.reads).toBe(2);
    expect(health.calls - prepareCalls).toBe(1);
    expect(run.fuseki.queries.filter(query => query.includes('text:query'))).toHaveLength(2);
  } finally { run.cleanup(); }
});

test('SEARCH11: denied Contribution admission performs no index health, source or text reads', async () => {
  const run = fixture();
  const health = observeHealth(run, 1);
  const operations: string[] = [];
  try {
    await expect(prepareAdmittedPrivateContributionPhrase(run.env, reader(operations, true),
      settlement(operations), principal, author, input)).rejects.toBeInstanceOf(AdmissionDenied);
    expect(operations).toEqual(['admit']);
    expect(health.reads).toBe(0);
    expect(run.fuseki.queries).toEqual([]);
  } finally { run.cleanup(); }
});

for (const hits of [true, false]) {
  test(`SEARCH11/SEARCH12: unrelated Main sequence changes preserve Contribution ${hits ? 'hit' : 'miss'}, provenance and budgets`, async () => {
    const run = fixture();
    const health = observeHealth(run);
    const operations: string[] = [];
    run.fuseki.hits = hits;
    advanceDiagnosticSequence(run);
    try {
      const session = await prepareAdmittedPrivateContributionPhrase(run.env, reader(operations),
        settlement(operations), principal, author, input);
      const prepareCalls = health.calls;
      expect(prepareCalls).toBeLessThanOrEqual(PRIVATE_SEARCH_FUSEKI_CALLS);
      expect(health.reads).toBe(2);
      let frame = '';
      expect(await session.send(message => { frame = message; return message.length; }))
        .toBeGreaterThan(0);
      const offered = JSON.parse(frame) as { type: string; leaseId: string; receiptChallenge: string;
        result: { profile: string; complete: boolean; total: number; results: unknown[] } };
      expect(offered).toMatchObject({ type: 'private-contribution-result-v1', leaseId,
        result: { profile: 'private-contribution-phrase-v1', contribution, complete: true,
          total: hits ? 1 : 0, results: hits ? [{ matchUnit: privateDraftUnit(revision),
            contribution, revision, field: 'body', language: 'en' }] : [],
          sourcePosition: { datasetId: 'product', dataEpoch: run.env.lineage.dataEpoch, sequence: '7' } } });
      expect(frame).not.toContain(body);
      expect(frame).not.toMatch(/score|snippet|facet|population/);
      expect(await session.receipt({ type: 'private-contribution-receipt-v1', leaseId,
        receiptChallenge: offered.receiptChallenge })).toBe(true);
      expect(operations).toEqual(['admit', 'begin', 'arm', 'delivered']);
      expect(health.calls - prepareCalls).toBe(PRIVATE_SEARCH_FINAL_FUSEKI_CALLS);
      expect(health.calls).toBeLessThanOrEqual(PRIVATE_SEARCH_FUSEKI_CALLS + PRIVATE_SEARCH_FINAL_FUSEKI_CALLS);
      expect(health.reads).toBe(3);
      expect(run.fuseki.reads).toBe(3);
      const textQueries = run.fuseki.queries.filter(query => query.includes('text:query'));
      expect(textQueries).toHaveLength(2);
      expect(textQueries.every(query => query.includes(`(<${privateDraftUnit(revision)}> ?score`)))
        .toBe(true);
    } finally { run.cleanup(); }
  });
}

test('SEARCH11: the Contribution diagnostic adapter keeps its observed sequence after unrelated Main movement', async () => {
  const run = fixture();
  observeHealth(run);
  advanceDiagnosticSequence(run);
  try {
    const result = await queryPrivateContributionPhrase(run.env, input);
    expect(result).toMatchObject({ complete: true, total: 1,
      sourcePosition: { datasetId: 'product', dataEpoch: run.env.lineage.dataEpoch, sequence: '7' },
      results: [{ contribution, revision, matchUnit: privateDraftUnit(revision) }] });
    expect(run.fuseki.reads).toBe(2);
  } finally { run.cleanup(); }
});

for (const fault of ['source head', 'source withdrawal', 'data epoch', 'restore hold',
  'native instance', 'index generation', 'private writer epoch'] as const) {
  for (const phase of ['preparation', 'delivery'] as const) {
    test(`SEARCH11/SEARCH12: Contribution ${fault} still fences ${phase} when diagnostic sequences are ignored`, async () => {
      const run = fixture();
      const health = observeHealth(run);
      const operations: string[] = [];
      changeLocalFence(run, health, phase === 'preparation' ? 2 : 3, fault);
      try {
        const prepare = () => prepareAdmittedPrivateContributionPhrase(run.env, reader(operations),
          settlement(operations), principal, author, input);
        if (phase === 'preparation') {
          await expect(prepare()).rejects.toBeInstanceOf(PrivateSearchUnavailable);
          expect(operations).toEqual(['admit', 'aborted']);
        } else {
          const session = await prepare();
          const frames: string[] = [];
          await expect(session.send(frame => { frames.push(frame); return 1; }))
            .rejects.toBeInstanceOf(PrivateSearchUnavailable);
          expect(frames).toEqual([]);
          expect(session.offered).toBe(false);
          expect(operations).toEqual(['admit', 'begin', 'arm', 'withheld']);
        }
        expect(health.calls).toBeLessThanOrEqual(PRIVATE_SEARCH_FUSEKI_CALLS + PRIVATE_SEARCH_FINAL_FUSEKI_CALLS);
      } finally { run.cleanup(); }
    });
  }
}

for (const closedAt of ['begin', 'arm'] as const) {
  test(`SEARCH12: Contribution authority closure at ${closedAt} still aborts before any frame`, async () => {
    const run = fixture();
    const health = observeHealth(run);
    const operations: string[] = [];
    advanceDiagnosticSequence(run);
    try {
      const session = await prepareAdmittedPrivateContributionPhrase(run.env,
        reader(operations, false, closedAt), settlement(operations), principal, author, input);
      const preparedCalls = health.calls;
      const frames: string[] = [];
      await expect(session.send(frame => { frames.push(frame); return 1; }))
        .rejects.toBeInstanceOf(AdmissionDenied);
      expect(frames).toEqual([]);
      expect(session.offered).toBe(false);
      expect(operations).toEqual(closedAt === 'begin'
        ? ['admit', 'begin', 'aborted'] : ['admit', 'begin', 'arm', 'aborted']);
      expect(health.calls).toBe(preparedCalls);
    } finally { run.cleanup(); }
  });
}

test('SEARCH11: the Contribution diagnostic adapter also refuses an uncertain index before exact custody', async () => {
  const run = fixture();
  const health = observeHealth(run, 1);
  run.env.objectDirectory = join(run.env.objectDirectory, 'unavailable-exact-custody');
  try {
    const error = await queryPrivateContributionPhrase(run.env, input)
      .then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(PrivateSearchUnavailable);
    expect((error as Error).message).toMatch(/uncertain/i);
    expect(health.reads).toBe(1);
    expect(run.fuseki.queries).toEqual([]);
  } finally { run.cleanup(); }
});
