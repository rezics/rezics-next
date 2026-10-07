import { expect, test } from 'bun:test';
import type { ContentCore, ExactContentReference } from '../../content/src/core.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult, type SparqlResult }
  from '../src/infrastructure/fuseki.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import { CONTENT_PRIVATE_SEARCH_COST, PrivateContentSearchUnavailable,
  prepareAdmittedPrivateContentPhrase } from '../src/modules/content-publication/search-private.ts';
import { ContentPrivateProjectionUnavailable, contentPrivateUnit }
  from '../src/modules/content-publication/search-private-projection.ts';
import { PRIVATE_SEARCH_GRAPH } from '../src/modules/contribution/private-projection.ts';
import type { PrivateSearchSettlement } from '../src/modules/contribution/private-search-settlement.ts';
import type { ContentSearchReadAccess } from '../src/modules/search-disclosure/content-read-lease.ts';
import { RV, hash, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const resource = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
const variant = 'urn:rezics:variant:00000000-0000-4000-8000-000000000012';
const revision = '00000000-0000-4000-8000-000000000013';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000014';
const ownerEpoch = '00000000-0000-4000-8000-000000000015';
const graphEpoch = '00000000-0000-4000-8000-000000000016';
const generation = 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000017';
const leaseId = '00000000-0000-4000-8000-000000000018';
const principal = { issuer: 'https://account.test', subject: 'reader' };
const body = 'Hidden nebula phrase';
const serializedJson = JSON.stringify({ body });
const reference: ExactContentReference = { owner: 'content', resourceId: resource,
  variantId: variant, revisionId: revision, format: 'rezics-content-json-v1',
  model: 'content-shape-v1', byteDigest: hash(serializedJson),
  byteLength: Buffer.byteLength(serializedJson), language: { kind: 'tag', tag: 'en', originalTag: 'en' },
  direction: 'ltr', sourceRevision: null, predecessor: null, provenance: {} };

const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string, language?: string) => ({ type: 'literal', value,
  ...(language ? { 'xml:lang': language } : {}) });
const bindings = (row?: Record<string, ReturnType<typeof literal>>): SparqlResult =>
  ({ results: { bindings: row ? [row] : [] } });

/** One exact owner revision and a healthy native projection, with uncertainty
 * injected at an existing health read instead of replacing production modules. */
class PrivateContentIndex extends FusekiClient {
  healthReads = 0;
  queries: string[] = [];
  commands: CommandEnvelope[] = [];
  uncertain = false;
  uncertainAt = 0;
  hits = true;
  constructor() { super('http://localhost:1/rezics'); }

  override async commandHealth() {
    this.healthReads++;
    return { moduleVersion: COMMAND_MODULE_VERSION,
      instanceId: '00000000-0000-4000-8000-000000000019',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      privateSearchWriteEpoch: '0', privateSearchWriteActive: false,
      textIndexUncertain: this.uncertain || this.healthReads === this.uncertainAt,
      profiles: { 'content-private-match-unit-v1': profileRegistry['content-private-match-unit-v1'].sha256 } };
  }

  override async command(envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(envelope);
    return { status: 'committed', position: { datasetId: 'urn:rezics:dataset:product',
      dataEpoch: graphEpoch, sequence: '7' } };
  }

  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (sparql.includes('SELECT ?type')) return bindings();
    if (sparql.includes('SELECT ?body ?digest ?revision')) return bindings({
      body: literal(body, 'en'), digest: literal(reference.byteDigest),
      revision: uri(`urn:rezics:content:revision:${revision}`) });
    if (sparql.includes('SELECT ?sequence ?generation')) return bindings({
      sequence: literal('7'), generation: uri(generation) });
    if (sparql.includes('text:query')) return bindings(sparql.includes('privateBody:*') || this.hits
      ? { literal: literal(body, 'en'), graph: uri(PRIVATE_SEARCH_GRAPH),
        predicate: uri(`${RV}privateSearchBody`) } : undefined);
    throw new Error(`Unexpected private Content query: ${sparql}`);
  }

  get textQueries() { return this.queries.filter(query => query.includes('text:query')); }
}

function fixture() {
  const fuseki = new PrivateContentIndex();
  const operations: string[] = [];
  let contentReads = 0;
  let exactReads = 0;
  let currentRevision = revision;
  let deny = false;
  let receiptToken: string | undefined;
  let onArm: (() => void) | undefined;
  const source = {
    async readDraftHead(readResource, readVariant) {
      contentReads++;
      expect([readResource, readVariant]).toEqual([resource, variant]);
      return { revisionId: currentRevision,
        position: { owner: 'content' as const, dataEpoch: ownerEpoch, sequence: '6' } };
    },
    async readExactBatch(ids, authorize) {
      contentReads++;
      exactReads++;
      expect(ids).toEqual([revision]);
      expect([...await authorize(ids)]).toEqual([revision]);
      return [{ revisionId: revision, status: 'available' as const,
        reference, serializedJson, body: { body } }];
    },
  } satisfies Pick<ContentCore, 'readDraftHead' | 'readExactBatch'>;
  const lease = { id: leaseId, principalId: 'reader', actingSubject: actor,
    resource, variant, scope: `work:read:${resource}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'admitted' as const };
  const owner = {
    async admit(readPrincipal, actingSubject, readResource, readVariant) {
      operations.push('admit');
      expect([readPrincipal, actingSubject, readResource, readVariant])
        .toEqual([principal, actor, resource, variant]);
      if (deny) throw new AdmissionDenied('private Content read is denied');
      return lease;
    },
    async begin(id) {
      expect(id).toBe(leaseId);
      operations.push('begin');
      return { ...lease, state: 'delivering' as const };
    },
    async arm(id, token) {
      expect(id).toBe(leaseId);
      operations.push('arm');
      receiptToken = token;
      onArm?.();
    },
    async finish(id, outcome, token) {
      expect(id).toBe(leaseId);
      expect(token).toBe(outcome === 'delivered' ? receiptToken : undefined);
      operations.push(outcome);
    },
  } satisfies Pick<ContentSearchReadAccess, 'admit' | 'begin' | 'arm' | 'finish'>;
  const settlement = {
    async settle(id, token, outcome) {
      expect(id).toBe(leaseId);
      expect(receiptToken).toBe(token);
      operations.push(outcome);
      return outcome;
    },
  } satisfies Pick<PrivateSearchSettlement, 'settle'>;
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: '.temp',
    lineage: { dataEpoch: graphEpoch, routingEpoch: '1' } };
  return { fuseki, operations, get contentReads() { return contentReads; },
    get exactReads() { return exactReads; },
    deny() { deny = true; },
    onArm(action: () => void) { onArm = action; },
    moveSource() { currentRevision = '00000000-0000-4000-8000-000000000020'; },
    prepare: () => prepareAdmittedPrivateContentPhrase(env, source as unknown as ContentCore,
      owner as unknown as ContentSearchReadAccess, settlement, principal, actor,
      { resource, variant, phrase: 'nebula phrase' }) };
}

test('SEARCH11: initially uncertain private Content index aborts before exact bytes, projection or text', async () => {
  const run = fixture();
  run.fuseki.uncertain = true;
  const error = await run.prepare().then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(PrivateContentSearchUnavailable);
  expect((error as Error).cause).toBeInstanceOf(ContentPrivateProjectionUnavailable);
  expect(((error as Error).cause as Error).message).toBe('private Content index is uncertain');
  expect(run.operations).toEqual(['admit', 'aborted']);
  expect(run.contentReads).toBe(1);
  expect(run.exactReads).toBe(0);
  expect(run.fuseki.healthReads).toBe(1);
  expect(run.fuseki.commands).toEqual([]);
  expect(run.fuseki.textQueries).toEqual([]);
  expect(run.fuseki.queries).toHaveLength(1);
  expect(run.fuseki.queries[0]).toContain('SELECT ?type');
});

test('SEARCH11: denied private Content admission reaches no index health or exact source', async () => {
  const run = fixture();
  run.deny();
  run.fuseki.uncertain = true;
  await expect(run.prepare()).rejects.toBeInstanceOf(AdmissionDenied);
  expect(run.operations).toEqual(['admit']);
  expect(run.contentReads).toBe(0);
  expect(run.exactReads).toBe(0);
  expect(run.fuseki.healthReads).toBe(0);
  expect(run.fuseki.commands).toEqual([]);
  expect(run.fuseki.textQueries).toEqual([]);
});

for (const [phase, healthRead, textQueries] of [
  ['after projection', 2, 0], ['after text matching', 3, 2],
] as const) {
  test(`SEARCH11: index uncertainty ${phase} aborts the admitted private Content preparation`, async () => {
    const run = fixture();
    run.fuseki.uncertainAt = healthRead;
    const error = await run.prepare().then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(PrivateContentSearchUnavailable);
    expect((error as Error).message).toBe('private Content index is uncertain');
    expect(run.operations).toEqual(['admit', 'aborted']);
    expect(run.exactReads).toBe(1);
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.fuseki.healthReads).toBe(healthRead);
    expect(run.fuseki.textQueries).toHaveLength(textQueries);
  });
}

test('SEARCH12: uncertainty after the durable Content send arm withholds delivery without a frame', async () => {
  const run = fixture();
  const session = await run.prepare();
  run.onArm(() => { run.fuseki.uncertain = true; });
  const frames: string[] = [];
  await expect(session.send(frame => { frames.push(frame); return 1; }))
    .rejects.toThrow('private Content index is uncertain');
  expect(frames).toEqual([]);
  expect(session.offered).toBe(false);
  expect(run.operations).toEqual(['admit', 'begin', 'arm', 'withheld']);
  expect(run.fuseki.healthReads).toBe(4);
  expect(run.exactReads).toBe(1);
  expect(run.fuseki.commands).toHaveLength(1);
  expect(run.fuseki.textQueries).toHaveLength(2);
});

for (const hits of [true, false]) {
  test(`SEARCH11/SEARCH12: healthy private Content ${hits ? 'hit' : 'miss'} preserves receipt delivery and work ceilings`, async () => {
    const run = fixture();
    run.fuseki.hits = hits;
    const session = await run.prepare();
    let frame = '';
    expect(await session.send(message => { frame = message; return message.length; }))
      .toBeGreaterThan(0);
    const offered = JSON.parse(frame) as { type: string; leaseId: string; receiptChallenge: string;
      result: { profile: string; complete: boolean; total: number; results: unknown[] } };
    expect(offered).toMatchObject({ type: 'private-content-result-v1', leaseId,
      result: { profile: 'private-content-phrase-v1', complete: true, total: hits ? 1 : 0,
        results: hits ? [{ matchUnit: contentPrivateUnit(revision), resource, variant,
          revision, field: 'body', language: 'en' }] : [] } });
    expect(frame).not.toContain(body);
    expect(frame).not.toMatch(/score|snippet|facet|population/);
    expect(await session.receipt({ type: 'private-content-receipt-v1', leaseId,
      receiptChallenge: offered.receiptChallenge })).toBe(true);
    expect(run.operations).toEqual(['admit', 'begin', 'arm', 'delivered']);
    expect(run.contentReads).toBeLessThanOrEqual(CONTENT_PRIVATE_SEARCH_COST.contentReads);
    expect(run.fuseki.healthReads + run.fuseki.queries.length)
      .toBeLessThanOrEqual(CONTENT_PRIVATE_SEARCH_COST.fusekiReads);
    expect(run.fuseki.commands).toHaveLength(CONTENT_PRIVATE_SEARCH_COST.graphCommands);
    expect(run.fuseki.textQueries).toHaveLength(2);
    expect(run.fuseki.textQueries.every(query => query.includes(`(<${contentPrivateUnit(revision)}> ?score`)))
      .toBe(true);
  });
}

test('SEARCH12: healthy index still withholds a Content source replaced after send arm', async () => {
  const run = fixture();
  const session = await run.prepare();
  run.onArm(() => run.moveSource());
  let frames = 0;
  await expect(session.send(() => { frames++; return 1; }))
    .rejects.toThrow('Content private source moved before delivery');
  expect(frames).toBe(0);
  expect(run.operations).toEqual(['admit', 'begin', 'arm', 'withheld']);
  expect(run.fuseki.healthReads).toBe(4);
  expect(run.exactReads).toBe(1);
});
