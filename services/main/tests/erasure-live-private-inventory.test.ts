import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { documentVersion, parseDocument } from '@rezics/document';
import { FusekiClient, type CommandEnvelope, type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { CONTRIBUTION_PROFILE } from '../src/modules/contribution/draft.ts';
import { ContentErasureInvalid } from '../src/modules/erasure/content.ts';
import { assertErasureJournalTargetBound, GraphErasureUnavailable,
  inventoryContributionPayloads } from '../src/modules/erasure/graph.ts';
import { ErasureInvalid, journalErasure } from '../src/modules/erasure/journal.ts';
import { ErasureService, requestContentErasure } from '../src/modules/erasure/request.ts';
import { resolveErasureRevisions, type ResolvedErasureRevision } from '../src/modules/erasure/revision-kind.ts';
import { ID, prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

type Binding = NonNullable<SparqlResult['results']>['bindings'][number];

const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string, datatype?: string) => ({ type: 'literal', value, ...(datatype ? { datatype } : {}) });
const resource = () => `${ID}${randomUUID()}`;
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

class InventoryGraph extends FusekiClient {
  identityRows: Binding[] = [];
  referenceRows: Binding[] = [];
  commands = 0;
  queries: string[] = [];

  constructor() { super('http://erasure-private-inventory.invalid'); }

  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (sparql.includes('SELECT ?revision ?kind ?owner ?manifest ?erased')) {
      return { results: { bindings: this.identityRows } };
    }
    if (sparql.includes('SELECT ?revision ?component ?manifest ?erased ?duplicate')) {
      const manifest = /VALUES \?manifest \{ <([^>]+)> \}/.exec(sparql)?.[1];
      return { results: { bindings: this.referenceRows.filter(row => row.manifest?.value === manifest) } };
    }
    throw new Error('unexpected graph inventory query');
  }

  override async commandWithReceipt(_envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands++;
    return { status: 'committed' } as CommandResult;
  }
}

const root = resolve(import.meta.dir, '../../..');
let objectRoot = '';

beforeAll(() => {
  objectRoot = join(root, '.temp', `erasure-live-private-inventory-${randomUUID()}`);
  mkdirSync(objectRoot, { recursive: true, mode: 0o700 });
});

afterAll(() => { if (objectRoot) rmSync(objectRoot, { recursive: true, force: true }); });

interface ContributionFixture {
  revision: ResolvedErasureRevision;
  body: string;
  contentForm: 'body' | 'document';
}

function contributionFixture(contentForm: 'body' | 'document', body: string, component = resource()): ContributionFixture {
  const ref = randomUUID();
  const content = contentForm === 'body'
    ? { body }
    : { body, document: parseDocument({ version: documentVersion, profile: 'text',
      doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'paragraph' },
        content: [{ type: 'text', text: body }] }] } }) };
  const digest = prepareComponent(objectRoot, component, { work: resource(), author: resource(), language: 'en',
    ...content, publication: 'draft' }, CONTRIBUTION_PROFILE);
  return { revision: { kind: 'text_contribution_draft', ref, resourceId: component,
    graphIri: `${ID}${ref}`, manifest: `urn:rezics:sha256:${digest}`, erased: false }, body, contentForm };
}

function identityRow(revision: ResolvedErasureRevision, manifest: string | null = revision.manifest ?? null): Binding {
  return {
    revision: uri(revision.graphIri),
    kind: literal(revision.kind),
    owner: uri(revision.resourceId),
    ...(manifest === null ? {} : { manifest: uri(manifest) }),
    erased: literal(revision.erased ? 'true' : 'false', XSD_BOOLEAN),
  };
}

function referenceRow(revision: ResolvedErasureRevision, options: {
  graphIri?: string; component?: string; manifest?: string; erased?: boolean; duplicate?: boolean;
} = {}): Binding {
  return {
    revision: uri(options.graphIri ?? revision.graphIri),
    component: uri(options.component ?? revision.resourceId),
    manifest: uri(options.manifest ?? revision.manifest!),
    erased: literal(options.erased ? 'true' : 'false', XSD_BOOLEAN),
    duplicate: literal(options.duplicate ? 'true' : 'false', XSD_BOOLEAN),
  };
}

async function resolveRevisionSet(graph: InventoryGraph,
  revisions: readonly ResolvedErasureRevision[]): Promise<ResolvedErasureRevision[]> {
  graph.identityRows = revisions.map(revision => identityRow(revision));
  const content = { query: async () => ({ rows: [] }) } as unknown as Pool;
  return resolveErasureRevisions(content, graph, revisions[0]!.resourceId,
    revisions.map(revision => revision.ref));
}

test('body and document payload inventory returns exact local keys while retaining manifest identity', async () => {
  const component = resource();
  const body = contributionFixture('body', 'private body text', component);
  const document = contributionFixture('document', 'private document text', component);
  const graph = new InventoryGraph();
  const resolved = await resolveRevisionSet(graph, [body.revision, document.revision]);
  graph.referenceRows = [referenceRow(body.revision), referenceRow(document.revision)];

  const inventory = await inventoryContributionPayloads(graph, objectRoot, resolved);

  expect(inventory).toHaveLength(2);
  expect(inventory.map(item => item.contentForm).sort()).toEqual(['body', 'document']);
  expect(inventory.map(item => item.manifestRef)).toEqual([
    `sha256:${body.revision.manifest!.slice('urn:rezics:sha256:'.length)}`,
    `sha256:${document.revision.manifest!.slice('urn:rezics:sha256:'.length)}`,
  ]);
  expect(inventory.every(item => item.payloadRef.startsWith('sha256:')
    && item.payloadRef !== item.manifestRef)).toBe(true);
  expect(JSON.stringify(inventory)).not.toContain(body.body);
  expect(JSON.stringify(inventory)).not.toContain(document.body);
});

interface RequestAttempt {
  graph: InventoryGraph;
  objectDirectory?: string;
  revisionIds: string[];
}

/** Publication locking is separate from the relay journal and Content bytes. */
function preservationPool(): Pool {
  return { connect: async () => ({
    query: async (sql: string) => {
      if (!/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL\b)/.test(sql) && !sql.includes('pg_advisory_xact_lock'))
        throw new Error('Unexpected preservation read before target validation');
      return { rows: [] };
    }, release: () => {},
  }) } as unknown as Pool;
}

async function expectRefusedBeforeMutation(input: RequestAttempt,
  expectedError: typeof ContentErasureInvalid | typeof GraphErasureUnavailable): Promise<void> {
  const graph = input.graph;
  let journalConnections = 0;
  let contentWrites = 0;
  const relay = {
    query: async () => ({ rows: [] }),
    connect: async () => { journalConnections++; throw new Error('journal write must not start'); },
  } as unknown as Pool;
  const content = {
    query: async (sql: string) => {
      if (/^(\s*)(UPDATE|INSERT|DELETE)\b/i.test(sql)) contentWrites++;
      return { rows: [] };
    },
  } as unknown as Pool;
  const service = new ErasureService(relay, content, preservationPool());
  const admissionId = randomUUID();
  const actingSubject = resource();
  const resourceId = graph.identityRows[0]?.owner?.value ?? resource();
  const access = {
    register: async (request: { actingSubject: string; scope: string; action: string;
      idempotencyKey: string; requestDigest: string }) => ({ id: admissionId, principalId: 'principal',
      actingSubject: request.actingSubject, scope: request.scope, action: request.action,
      idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest,
      authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'registered' as const, dispatchEligible: true, replayed: false }),
    claim: async () => undefined,
    recordGraphOutcome: async () => undefined,
  } as never;
  const account = { verify: async () => ({ issuer: 'issuer', subject: 'subject' }) } as never;
  const environment = { fuseki: graph, lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    objectDirectory: input.objectDirectory ?? objectRoot } as unknown as WorkActivationEnvironment;

  await expect(requestContentErasure(service, environment, account, access, new Request('http://localhost'), {
    actingSubject, resourceId, revisionIds: input.revisionIds, idempotencyKey: randomUUID(),
  })).rejects.toBeInstanceOf(expectedError);
  expect(journalConnections).toBe(0);
  expect(contentWrites).toBe(0);
  expect(graph.commands).toBe(0);
}

test('foreign, missing and duplicate Contribution manifests fail closed before journaling', async () => {
  const fixture = contributionFixture('body', 'private body text');

  const foreignGraph = new InventoryGraph();
  const foreignComponent = resource();
  const foreignDigest = prepareComponent(objectRoot, foreignComponent, { work: resource(), author: resource(),
    language: 'en', body: 'foreign component body', publication: 'draft' }, CONTRIBUTION_PROFILE);
  const foreignManifest = `urn:rezics:sha256:${foreignDigest}`;
  foreignGraph.identityRows = [identityRow(fixture.revision, foreignManifest)];
  foreignGraph.referenceRows = [referenceRow(fixture.revision, { manifest: foreignManifest })];
  await expectRefusedBeforeMutation({ graph: foreignGraph, revisionIds: [fixture.revision.ref] },
    GraphErasureUnavailable);

  const missingGraph = new InventoryGraph();
  missingGraph.identityRows = [identityRow(fixture.revision, null)];
  await expectRefusedBeforeMutation({ graph: missingGraph, revisionIds: [fixture.revision.ref] },
    ContentErasureInvalid);

  const duplicateGraph = new InventoryGraph();
  duplicateGraph.identityRows = [identityRow(fixture.revision),
    identityRow(fixture.revision, `urn:rezics:sha256:${'ab'.repeat(32)}`)];
  await expectRefusedBeforeMutation({ graph: duplicateGraph, revisionIds: [fixture.revision.ref] },
    ContentErasureInvalid);
});

test('a shared live Contribution revision prevents erasure before any journal or graph command', async () => {
  const fixture = contributionFixture('body', 'shared private body');
  const graph = new InventoryGraph();
  graph.identityRows = [identityRow(fixture.revision)];
  graph.referenceRows = [referenceRow(fixture.revision), referenceRow(fixture.revision, {
    graphIri: `${ID}${randomUUID()}`,
  })];

  await expectRefusedBeforeMutation({ graph, revisionIds: [fixture.revision.ref] }, GraphErasureUnavailable);
});

test('the 65th reverse reference is refused before journal or graph mutation', async () => {
  const fixture = contributionFixture('body', 'bounded private body');
  const graph = new InventoryGraph();
  graph.identityRows = [identityRow(fixture.revision)];
  graph.referenceRows = [referenceRow(fixture.revision), ...Array.from({ length: 64 }, () =>
    referenceRow(fixture.revision, { graphIri: `${ID}${randomUUID()}` }))];

  await expectRefusedBeforeMutation({ graph, revisionIds: [fixture.revision.ref] }, GraphErasureUnavailable);
  expect(graph.queries.some(query => query.includes('LIMIT 65'))).toBe(true);
});

test('reverse-reference lookahead is applied per manifest across 64 candidates', async () => {
  const component = resource();
  const fixtures = Array.from({ length: 64 }, (_, index) =>
    contributionFixture('body', `candidate private body ${index}`, component));
  const graph = new InventoryGraph();
  const resolved = await resolveRevisionSet(graph, fixtures.map(fixture => fixture.revision));
  graph.referenceRows = [
    ...resolved.map(revision => referenceRow(revision)),
    referenceRow(resolved[0]!, { graphIri: `${ID}${randomUUID()}`, erased: true }),
  ];

  const inventory = await inventoryContributionPayloads(graph, objectRoot, resolved);

  expect(inventory).toHaveLength(64);
  expect(graph.queries.filter(query => query.includes('SELECT ?revision ?component ?manifest ?erased ?duplicate')))
    .toHaveLength(64);
  const closureSize = resolved.length + new Set(inventory.map(item => item.payloadRef)).size;
  expect(closureSize).toBe(128);
  expect(closureSize).toBeLessThan(256);
});

test('graph preflight and journal agree at the 256 target boundary', async () => {
  const makeTargets = (count: number) => Array.from({ length: count }, (_, index) => ({
    kind: 'object' as const, ref: `sha256:${String(index).padStart(64, '0')}`,
  }));
  const accepted = makeTargets(256);
  const oversized = makeTargets(257);

  expect(() => assertErasureJournalTargetBound(accepted)).not.toThrow();
  expect(() => assertErasureJournalTargetBound(oversized)).toThrow(GraphErasureUnavailable);

  let connections = 0;
  const relay = { connect: async () => {
    connections++;
    throw new Error('bounded targets reached the journal transaction');
  } } as unknown as Pool;
  const intent = { operationId: randomUUID(), requestDigest: '0'.repeat(64), kind: 'revision' as const,
    principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: '1', targets: accepted };

  await expect(journalErasure(relay, intent)).rejects.toThrow('reached the journal transaction');
  expect(connections).toBe(1);
  await expect(journalErasure(relay, { ...intent, targets: oversized })).rejects.toBeInstanceOf(ErasureInvalid);
  expect(connections).toBe(1);
});

test('a 257th requested revision is refused before target reads, journaling or graph mutation', async () => {
  const graph = new InventoryGraph();
  const revisions = Array.from({ length: 257 }, () => randomUUID());
  const relay = {
    query: async () => ({ rows: [] }),
    connect: async () => { throw new Error('journal write must not start'); },
  } as unknown as Pool;
  let contentReads = 0;
  const content = { query: async () => { contentReads++; return { rows: [] }; } } as unknown as Pool;
  const service = new ErasureService(relay, content, preservationPool());
  const id = randomUUID();
  const access = { register: async (request: { actingSubject: string; scope: string; action: string;
      idempotencyKey: string; requestDigest: string }) => ({ id, principalId: 'principal',
      actingSubject: request.actingSubject, scope: request.scope, action: request.action,
      idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest, authorityEpoch: '1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'registered' as const,
      dispatchEligible: true, replayed: false }), claim: async () => undefined,
    recordGraphOutcome: async () => undefined } as never;
  const environment = { fuseki: graph, lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    objectDirectory: objectRoot } as unknown as WorkActivationEnvironment;

  await expect(requestContentErasure(service, environment,
    { verify: async () => ({ issuer: 'issuer', subject: 'subject' }) } as never, access,
    new Request('http://localhost'), { actingSubject: resource(), resourceId: resource(),
      revisionIds: revisions, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ContentErasureInvalid);
  expect(contentReads).toBe(0);
  expect(graph.queries).toEqual([]);
  expect(graph.commands).toBe(0);
});
