import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { AdmissionDenied, type AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { CONTRIBUTION_PROFILE } from '../src/modules/contribution/draft.ts';
import { privateDraftTriples, privateDraftUnit } from '../src/modules/contribution/private-projection.ts';
import { InvalidPrivateQuery, PrivateSearchUnavailable, prepareAdmittedPrivateContributionPhrase,
  queryPrivateContributionPhrase }
  from '../src/modules/contribution/search-private.ts';
import { prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const contribution = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000012';
const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000013';
const author = 'https://rezics.com/id/00000000-0000-4000-8000-000000000014';
const body = 'Hidden nebula phrase';
const epoch = '00000000-0000-4000-8000-000000000015';
const generation = 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000016';
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string, language?: string) => ({ type: 'literal', value,
  ...(language ? { 'xml:lang': language } : {}) });
const bindings = (row?: Record<string, ReturnType<typeof literal> | ReturnType<typeof uri>>) =>
  ({ results: { bindings: row ? [row] : [] } });

class PrivateFixture extends FusekiClient {
  queries: string[] = [];
  hits = true;
  indexed = true;
  projected = true;
  moved = false;
  commandOnly = true;
  privateEpoch = '0';
  reads = 0;
  constructor(readonly manifest: string) { super('http://localhost:1/rezics'); }
  override async commandHealth() { return { moduleVersion: '0.5.16',
    instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
    privateSearchWriteEpoch: this.privateEpoch, privateSearchWriteActive: false,
    publicSearchDeltaAvailable: this.commandOnly, profiles: {} }; }
  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (sparql.includes('SELECT ?head ?sequence ?generation')) {
      this.reads++;
      return bindings({ head: uri(this.moved && this.reads >= 2 ? author : revision),
        sequence: literal('7'), generation: uri(generation) });
    }
    if (sparql.includes('SELECT ?component ?manifest')) return bindings({
      component: uri(contribution), manifest: uri(`urn:rezics:sha256:${this.manifest}`),
      model: uri(CONTRIBUTION_PROFILE), shape: uri(CONTRIBUTION_PROFILE),
      dataset: uri('urn:rezics:dataset:product'), epoch: literal(epoch), sequence: literal('6'),
    });
    if (sparql.includes('ASK')) return { boolean: true };
    if (sparql.includes('SELECT ?body')) return bindings(this.projected
      ? { body: literal(body, 'en') } : undefined);
    if (sparql.includes('privateBody:*')) return bindings(this.indexed
      ? { literal: literal(body, 'en'), graph: uri('urn:rezics:search:private'),
        predicate: uri('https://rezics.com/vocab/privateSearchBody') } : undefined);
    if (sparql.includes('text:query')) return bindings(this.hits
      ? { literal: literal(body, 'en'), graph: uri('urn:rezics:search:private'),
        predicate: uri('https://rezics.com/vocab/privateSearchBody') } : undefined);
    throw new Error(`unexpected query: ${sparql}`);
  }
}

function fixture() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp', 'private-search-'));
  const manifest = prepareComponent(directory, contribution,
    { work, author, language: 'en', body, publication: 'draft' }, CONTRIBUTION_PROFILE);
  const fuseki = new PrivateFixture(manifest);
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: directory,
    lineage: { dataEpoch: epoch, routingEpoch: '1' } };
  return { env, fuseki, cleanup: () => rmSync(directory, { force: true, recursive: true }) };
}

test('SEARCH11 projection has a distinct private field, unit and no public body predicate', () => {
  const triples = privateDraftTriples(contribution, revision, work, 'en', body);
  expect(triples).toContain(`<${privateDraftUnit(revision)}>`);
  expect(triples).toContain('privateSearchBody');
  expect(triples).toContain('Private');
  expect(triples).not.toContain('<https://rezics.com/vocab/searchBody>');
  for (const path of ['infra/jena/fuseki-text.ttl', 'infra/jena/fuseki-text-qa.ttl',
    'infra/jena/fuseki-text-qa-raw.ttl', 'docs/operations/examples/fuseki-text.ttl']) {
    const assembler = readFileSync(join(root, path), 'utf8');
    expect(assembler).toContain('text:field "body" ; text:predicate rv:searchBody');
    expect(assembler).toContain('text:field "privateBody" ; text:predicate rv:privateSearchBody');
  }
});

test('SEARCH11 concrete private subject is bound before matching and a missing posting is unavailable', async () => {
  const run = fixture();
  try {
    const input = { contribution, phrase: 'nebula phrase' };
    const result = await queryPrivateContributionPhrase(run.env, input);
    expect(result.total).toBe(1);
    expect(JSON.stringify(result)).not.toContain('score');
    for (const query of run.fuseki.queries.filter(value => value.includes('text:query'))) {
      expect(query).toContain(`(<${privateDraftUnit(revision)}> ?score`);
      expect(query).toContain('rv:privateSearchBody');
      expect(query).toContain('GRAPH <urn:rezics:search:private>');
    }
    run.fuseki.hits = false;
    expect((await queryPrivateContributionPhrase(run.env, input)).total).toBe(0);
    run.fuseki.indexed = false;
    await expect(queryPrivateContributionPhrase(run.env, input))
      .rejects.toBeInstanceOf(PrivateSearchUnavailable);
  } finally { run.cleanup(); }
});

test('SEARCH12 moved head or missing exact projection cannot become a complete empty result', async () => {
  const run = fixture();
  try {
    run.fuseki.projected = false;
    await expect(queryPrivateContributionPhrase(run.env, { contribution, phrase: 'nebula' }))
      .rejects.toBeInstanceOf(PrivateSearchUnavailable);
    run.fuseki.projected = true;
    run.fuseki.moved = true;
    run.fuseki.reads = 0;
    await expect(queryPrivateContributionPhrase(run.env, { contribution, phrase: 'nebula' }))
      .rejects.toBeInstanceOf(PrivateSearchUnavailable);
  } finally { run.cleanup(); }
});

test('SEARCH12 a writable raw Jena endpoint invalidates the private writer fence', async () => {
  const run = fixture();
  try {
    run.fuseki.commandOnly = false;
    await expect(queryPrivateContributionPhrase(run.env, { contribution, phrase: 'nebula' }))
      .rejects.toBeInstanceOf(PrivateSearchUnavailable);
    expect(run.fuseki.queries).toEqual([]);
  } finally { run.cleanup(); }
});

test('SEARCH11 private match cannot start before exact Access admission', async () => {
  const run = fixture();
  const principal = { issuer: 'https://account.test', subject: 'reader' };
  const denied = { admitContributionSearchRead: async () => {
    throw new AdmissionDenied('no private grant');
  } } as unknown as AccessAdmissionRegistry;
  try {
    await expect(prepareAdmittedPrivateContributionPhrase(run.env, denied, principal, author,
      { contribution, phrase: 'nebula' })).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(prepareAdmittedPrivateContributionPhrase(run.env, denied, principal, author,
      { contribution, phrase: 'x' })).rejects.toBeInstanceOf(InvalidPrivateQuery);
    expect(run.fuseki.queries).toEqual([]);
  } finally { run.cleanup(); }
});

test('SEARCH12 moved native head before send aborts an unarmed read without offering a frame', async () => {
  const run = fixture();
  const operations: string[] = [];
  const leaseId = '00000000-0000-4000-8000-000000000018';
  const access = {
    admitContributionSearchRead: async () => { operations.push('admit'); return { id: leaseId }; },
    beginContributionSearchDelivery: async () => { operations.push('begin'); return { id: leaseId }; },
    armContributionSearchSend: async () => { operations.push('arm'); },
    finishContributionSearchRead: async (_id: string, outcome: string) => { operations.push(outcome); },
  } as unknown as AccessAdmissionRegistry;
  try {
    const session = await prepareAdmittedPrivateContributionPhrase(run.env, access,
      { issuer: 'https://account.test', subject: 'reader' }, author,
      { contribution, phrase: 'nebula' });
    expect(operations).toEqual(['admit']);
    expect(run.fuseki.queries.some(query => query.includes('text:query'))).toBe(true);
    run.fuseki.moved = true;
    let offered = false;
    await expect(session.send(() => { offered = true; return 1; }))
      .rejects.toBeInstanceOf(PrivateSearchUnavailable);
    expect(offered).toBe(false);
    expect(operations).toEqual(['admit', 'begin', 'aborted']);
    expect(run.fuseki.reads).toBe(3);
  } finally { run.cleanup(); }
});

test('SEARCH12 changed private index epoch before send cannot return a stale match', async () => {
  const run = fixture();
  const operations: string[] = [];
  const leaseId = '00000000-0000-4000-8000-00000000001a';
  const access = {
    admitContributionSearchRead: async () => { operations.push('admit'); return { id: leaseId }; },
    beginContributionSearchDelivery: async () => { operations.push('begin'); return { id: leaseId }; },
    armContributionSearchSend: async () => { operations.push('arm'); },
    finishContributionSearchRead: async (_id: string, outcome: string) => { operations.push(outcome); },
  } as unknown as AccessAdmissionRegistry;
  try {
    const session = await prepareAdmittedPrivateContributionPhrase(run.env, access,
      { issuer: 'https://account.test', subject: 'reader' }, author,
      { contribution, phrase: 'nebula' });
    run.fuseki.privateEpoch = '2';
    let offered = false;
    await expect(session.send(() => { offered = true; return 1; }))
      .rejects.toBeInstanceOf(PrivateSearchUnavailable);
    expect(offered).toBe(false);
    expect(operations).toEqual(['admit', 'begin', 'aborted']);
  } finally { run.cleanup(); }
});

test('SEARCH11/SEARCH12 admitted private phrase reaches one receipt-fenced frame', async () => {
  const run = fixture();
  const operations: string[] = [];
  const leaseId = '00000000-0000-4000-8000-000000000019';
  let expectedToken: string | undefined;
  const access = {
    admitContributionSearchRead: async () => { operations.push('admit'); return { id: leaseId }; },
    beginContributionSearchDelivery: async () => { operations.push('begin'); return { id: leaseId }; },
    armContributionSearchSend: async (_id: string, token: string) => {
      operations.push('arm'); expectedToken = token;
    },
    finishContributionSearchRead: async (_id: string, outcome: string, token?: string) => {
      operations.push(outcome); if (outcome === 'delivered') expect(token).toBe(expectedToken);
    },
  } as unknown as AccessAdmissionRegistry;
  try {
    const session = await prepareAdmittedPrivateContributionPhrase(run.env, access,
      { issuer: 'https://account.test', subject: 'reader' }, author,
      { contribution, phrase: 'nebula' });
    let frame = '';
    expect(await session.send(value => { operations.push('send'); frame = value; return value.length; }))
      .toBeGreaterThan(0);
    expect(operations).toEqual(['admit', 'begin', 'arm', 'send']);
    expect(run.fuseki.reads).toBe(3);
    const message = JSON.parse(frame) as { leaseId: string; receiptChallenge: string;
      result: { total: number; results: unknown[] } };
    expect(message.result.total).toBe(1);
    expect(message.result.results).toHaveLength(1);
    expect(message.leaseId).toBe(leaseId);
    if (!expectedToken) throw new Error('private receipt challenge was not armed');
    expect(message.receiptChallenge).toBe(expectedToken);
    expect(await session.receipt(JSON.stringify({ type: 'private-contribution-receipt-v1',
      leaseId, receiptChallenge: '00'.repeat(32) }))).toBe(false);
    expect(operations).toEqual(['admit', 'begin', 'arm', 'send']);
    expect(await session.receipt(JSON.stringify({ type: 'private-contribution-receipt-v1',
      leaseId, receiptChallenge: expectedToken }))).toBe(true);
    expect(operations).toEqual(['admit', 'begin', 'arm', 'send', 'delivered']);
  } finally { run.cleanup(); }
});

test('SEARCH12 HTTP route fails closed until socket delivery completion is proven', async () => {
  const run = fixture();
  const operations: string[] = [];
  const id = '00000000-0000-4000-8000-000000000017';
  const access = {
    admitContributionSearchRead: async () => { operations.push('admit'); return { id }; },
    beginContributionSearchDelivery: async () => { operations.push('begin'); return { id }; },
    finishContributionSearchRead: async (_id: string, outcome: string) => { operations.push(outcome); },
  } as unknown as MainWorkDependencies['access'];
  const app = createMainApp(run.fuseki, { environment: run.env,
    account: { verify: async () => ({ issuer: 'issuer', subject: 'subject' }) },
    access } as MainWorkDependencies);
  try {
    const response = await app.handle(new Request('http://localhost/v1/private-queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'private-contribution-phrase-v1', contribution,
        actingSubject: author, phrase: 'nebula phrase' }),
    }));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('private_search_unavailable');
    expect(operations).toEqual([]);
    expect(run.fuseki.queries).toEqual([]);
  } finally { run.cleanup(); }
});

test('SEARCH11 unsupported private requests never reach Access, graph or Lucene', async () => {
  const run = fixture();
  const app = createMainApp(run.fuseki, { environment: run.env,
    account: { verify: async () => ({ issuer: 'issuer', subject: 'subject' }) },
    access: { admitContributionSearchRead: async () => {
      throw new Error('unexpected admission');
    }, beginContributionSearchDelivery: async () => { throw new Error('unexpected delivery'); },
    finishContributionSearchRead: async () => { throw new Error('unexpected finish'); },
    } as unknown as MainWorkDependencies['access'],
  } as MainWorkDependencies);
  try {
    const response = await app.handle(new Request('http://localhost/v1/private-queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'private-contribution-phrase-v1', contribution,
        actingSubject: author, phrase: 'nebula phrase' }),
    }));
    expect(response.status).toBe(503);
    expect(run.fuseki.queries).toEqual([]);
    expect(JSON.stringify(await response.json())).not.toContain(body);
  } finally { run.cleanup(); }
});
