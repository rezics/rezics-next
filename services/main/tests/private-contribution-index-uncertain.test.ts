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

function reader(operations: string[], denied = false): PrivateSearchAccess {
  return {
    admitContributionSearchRead: async () => {
      operations.push('admit');
      if (denied) throw new AdmissionDenied('no private Contribution grant');
      return { id: leaseId };
    },
    beginContributionSearchDelivery: async () => {
      operations.push('begin');
      return { id: leaseId };
    },
    armContributionSearchSend: async () => { operations.push('arm'); },
    finishContributionSearchRead: async (_id: string, outcome: string) => { operations.push(outcome); },
  } as unknown as PrivateSearchAccess;
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
  test(`SEARCH11/SEARCH12: healthy Contribution ${hits ? 'hit' : 'miss'} preserves the prepare/send budgets and receipt`, async () => {
    const run = fixture();
    const health = observeHealth(run);
    const operations: string[] = [];
    run.fuseki.hits = hits;
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
      const textQueries = run.fuseki.queries.filter(query => query.includes('text:query'));
      expect(textQueries).toHaveLength(2);
      expect(textQueries.every(query => query.includes(`(<${privateDraftUnit(revision)}> ?score`)))
        .toBe(true);
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
