import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import pinned from '../../../../specs/fixtures/imports/bangumi/public-book-meta-tags.json';
import { convertBangumi } from '../../../../packages/conversion/src/bangumi.ts';
import {
  Importer,
  isUnavailableIdentifierResolution,
  type ImportIdentifierResolution,
} from '../../../importer/src/importer.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import {
  seedReviewedCatalogue,
  createReviewedCatalogueLookup,
  readReviewedBangumiBinding,
  reviewedCatalogueOwner,
  type ReviewedCataloguePort,
} from '../../../importer/src/reviewed-catalogue.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { statementSlotId } from '../../src/semantic/item.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import { openGrowthDatabase, checkGrowth, seed, type GrowthDatabase } from '../support/growth.ts';

let f: ReleasedDiscoveryFixture;
let db: GrowthDatabase;
let directory: string;
let path: string;
let port: ReturnType<typeof createImportTransport>;

function resolvedReferences(resolution: ImportIdentifierResolution): Readonly<Record<string, string>> {
  if (isUnavailableIdentifierResolution(resolution)) {
    if (!resolution.resolvedReferences) throw new Error('Missing resolved references for reviewed catalogue seed');
    return resolution.resolvedReferences;
  }
  return resolution;
}
beforeAll(async () => {
  const temporary = fileURLToPath(new URL('../../../../.temp/', import.meta.url));
  await mkdir(temporary, { recursive: true });
  directory = await mkdtemp(join(temporary, 'reviewed-catalogue-'));
  path = join(directory, 'state.sqlite');
  await writeFile(path, '', { mode: 0o600 });
  f = await createReleasedDiscoveryFixture({
    version: 1,
    kernelPool: async (url) => {
      db = await openGrowthDatabase(url);
      return db.pool;
    },
  });
  port = await f.reviewedCatalogueOperator('alice');
}, 180_000);
afterAll(async () => {
  // The native fixture owns and closes the runtime pool; this file owns the capture admin pool.
  await db?.admin.end();
  await f?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);
function transport(p: ReviewedCataloguePort) {
  return {
    batchWrite: (request: Parameters<typeof p.batch>[0]) => p.batch(request),
    setSourceRecordMetadata: p.setSourceRecordMetadata,
    readFence: (tuple: { source: string; external_id: string; field_group: 'facts' | 'summary' | 'cover' }) =>
      p.fence({ source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group }),
  };
}
function keyword(commands: readonly BatchCommand[]) {
  return commands.filter((c) => c.op === 'propose' && c.statement.property.id === 'schema:keywords');
}
async function lookup() {
  const session = new ImportSession(path);
  try {
    return await readReviewedBangumiBinding(session.bindings, port);
  } finally {
    session.close();
  }
}

test('actual reviewed platform seed producer obtains native metadata ACK before durable claim proposal acceptance and adoption and reopens the same journal without duplicate identity', async () => {
  expect(await lookup()).toBeNull();
  let batches = 0;
  // Real denied actor at the same Auth/Access boundary; no fabricated metadata receipt.
  const denied = createImportTransport({
    origin: 'https://reviewed.discovery.test',
    tokenProvider: async () => f.personas.outsider.bearer,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const bytes = await request.text();
      const response = await f.request(
        'outsider',
        request.method as 'GET' | 'POST',
        url.pathname + url.search,
        bytes ? JSON.parse(bytes) : undefined,
        Object.fromEntries(request.headers),
      );
      return Response.json(response.body, { status: response.status, headers: response.headers });
    }) as typeof fetch,
  });
  await expect(
    seedReviewedCatalogue({
      path,
      port: {
        ...port,
        setSourceRecordMetadata: denied.setSourceRecordMetadata,
        batch: async (...args) => {
          batches++;
          return port.batch(...args);
        },
      },
    }),
  ).rejects.toThrow();
  expect(batches).toBe(0);
  const metadataRequests: unknown[] = [];
  let lose = true;
  await expect(
    seedReviewedCatalogue({
      path,
      port: {
        ...port,
        setSourceRecordMetadata: async (...args) => {
          metadataRequests.push(structuredClone(args[0]));
          const result = await port.setSourceRecordMetadata(...args);
          if (lose) {
            lose = false;
            throw new Error('Lost actual native metadata response');
          }
          return result;
        },
        batch: async (...args) => {
          batches++;
          return port.batch(...args);
        },
      },
    }),
  ).rejects.toThrow('Lost actual native metadata response');
  expect(batches).toBe(0);
  const acknowledged = new Set<string>();
  const events: string[] = [];
  const actual = await seedReviewedCatalogue({
    path,
    port: {
      ...port,
      setSourceRecordMetadata: async (...args) => {
        metadataRequests.push(structuredClone(args[0]));
        const receipt = await port.setSourceRecordMetadata(...args);
        acknowledged.add(args[0].command.external_id);
        events.push('metadata');
        return receipt;
      },
      batch: async (...args) => {
        for (const c of args[0].commands) expect(acknowledged.has(c.source.external_id)).toBe(true);
        events.push(args[0].commands[0]!.op);
        return port.batch(...args);
      },
    },
  });
  expect(metadataRequests[1]).toEqual(metadataRequests[0]);
  expect(events[0]).toBe('metadata');
  expect(new Set(Object.values(actual.subjects)).size).toBe(4);
  expect(actual.facts).toHaveLength(6);
  for (const fact of actual.facts) {
    expect(fact.acceptance.acceptance).toMatchObject({ candidate: fact.candidate, decision: 'accept' });
    expect(fact.adoption.adoption.selection).toContainEqual({ candidate: fact.candidate, rank: 'preferred' });
  }
  expect(await lookup()).toEqual({
    sourceConcept: actual.subjects['source-harem']!,
    canonicalConcept: actual.subjects['canonical-harem']!,
  });
  const repeated = await seedReviewedCatalogue({ path, port });
  expect(repeated.subjects).toEqual(actual.subjects);
  expect(repeated.facts.map((r) => r.candidate)).toEqual(actual.facts.map((r) => r.candidate));
  const journal = new ImportSession(path);
  try {
    const owner = reviewedCatalogueOwner('https://rezics.com/schemes/bangumi/public-tags', '后宫');
    const candidates = journal.bindings.candidates(owner, 'facts', { limit: 100 });
    expect(candidates).toHaveLength(2);
    const bob = await f.reviewedCatalogueOperator('bob');
    // Fresh key and a separately authenticated authorized account resolve the same native claim.
    const source = JSON.parse(candidates[0]!.bytes).commands[0].source;
    const resolved = await bob.batch({
      commands: [
        { op: 'create', key: randomUUID(), source, subject: { type: 'skos:Concept', labels: { zh: '后宫' } } },
      ],
    });
    expect(resolved.results[0]).toMatchObject({ status: 200, value: { id: actual.subjects['source-harem'] } });
  } finally {
    journal.close();
  }
}, 180_000);

test('actual Bangumi public meta_tags binds the current source Concept through the existing importer lookup and converter while current hidden retracted or missing bindings omit the proposal', async () => {
  const binding = await lookup();
  expect(binding).not.toBeNull();
  const commands: BatchCommand[] = [];
  const options = { path, transport: transport(port) };
  const liveOptions: ConstructorParameters<typeof Importer>[0] = {
    ...options,
    afterBulkSuccess(request) {
      commands.push(...request.commands);
    },
  };
  const live = new Importer(liveOptions);
  liveOptions.identifierLookup = createReviewedCatalogueLookup(live.session.bindings, port);
  try {
    const result = await live.runRecords(
      createSourceRegistration('bangumi'),
      (async function* () {
        yield { source: 'bangumi' as const, key: '498', revision: null, payload: pinned };
      })(),
    );
    expect(result.status).toBe('committed');
    expect(keyword(commands)).toHaveLength(1);
    expect(keyword(commands)[0]).toMatchObject({ statement: { value: { content: binding!.sourceConcept } } });
    expect(JSON.stringify(keyword(commands))).not.toContain(binding!.canonicalConcept);
    expect(
      commands.some((c) => c.op === 'propose' && ['wdt:P7937', 'schema:wordCount'].includes(c.statement.property.id)),
    ).toBe(false);
    const context = { subjectId: binding!.sourceConcept };
    expect(
      keyword(convertBangumi({ external_id: '498', record_revision: null, record: pinned }, context).proposals),
    ).toEqual([]);
    expect(
      keyword(
        convertBangumi(
          {
            external_id: '498',
            record_revision: null,
            record: { ...pinned, meta_tags: [], tags: [{ name: '后宫' }], privateCollectionLabels: ['后宫'] },
          },
          context,
        ).proposals,
      ),
    ).toEqual([]);
  } finally {
    await live.close();
  }
}, 180_000);

test('normalization and current native binding validation stay bounded through real catalogue and history growth', async () => {
  const binding = await lookup();
  expect(binding).not.toBeNull();
  const route = routeOf(binding!.sourceConcept)!;
  const session = new ImportSession(path);
  try {
    const read = createReviewedCatalogueLookup(session.bindings, port);
    const conversion = createSourceRegistration('bangumi').convert(
      { external_id: '498', record_revision: null, record: pinned },
      { source: 'bangumi' },
    );
    for (const axis of ['catalogue', 'history'] as const) {
      const report = await checkGrowth(db, {
        name: `Reviewed catalogue production lookup ${axis}`,
        scales: [64, 512, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        grow: async (database, scale, previous) => {
          await seed(
            database,
            {
              name: `reviewed-lookup-${axis}`,
              hotPartition: partitionOf(route),
              hotShare: 1,
              rows: ({ ordinal }) => {
                const id = axis === 'catalogue' ? newId(route) : binding!.sourceConcept;
                const transaction = randomUUID();
                return axis === 'catalogue'
                  ? {
                      'semantic.subject': [
                        { route, subject_id: id, type: 'skos:Concept', recorded_transaction_id: transaction },
                      ],
                    }
                  : {
                      'semantic.revision': [
                        {
                          route,
                          subject_id: id,
                          revision: 1000 + ordinal,
                          kind: 'propose',
                          release: bundledDigest,
                          recorded_transaction_id: transaction,
                        },
                      ],
                      'semantic.candidate': [
                        {
                          route,
                          subject_id: id,
                          candidate_id: newId(route),
                          slot_id: statementSlotId(id, 'schema:url'),
                          property: 'schema:url',
                          rank: 'normal',
                          statement: {
                            property: { id: 'schema:url', data_type: 'url' },
                            value: { type: 'value', content: `https://example.test/${ordinal}` },
                            qualifiers: [],
                            references: [],
                            rank: 'normal',
                          },
                          release: bundledDigest,
                          revision: 1000 + ordinal,
                          origin: 'proposal',
                          view_order: 0,
                        },
                      ],
                    };
              },
            },
            { from: previous, to: scale },
          );
        },
        operation: async () => {
          const references = await read.resolve({
            owner: { source: 'bangumi', external_id: '498' },
            conversion,
            signal: new AbortController().signal,
          });
          const resolved = resolvedReferences(references);
          expect(Object.values(resolved)).toEqual([binding!.sourceConcept]);
          const output = convertBangumi(
            { external_id: '498', record_revision: null, record: pinned },
            { subjectId: binding!.sourceConcept, resolvedReferences: resolved },
          );
          expect(keyword(output.proposals)).toHaveLength(1);
          return output;
        },
      });
      expect(report.samples).toHaveLength(3);
    }
  } finally {
    session.close();
  }
}, 180_000);

test('current retraction and hidden originals cannot reuse retained Context adoption as public binding authority', async () => {
  const session = new ImportSession(path);
  try {
    const owner = reviewedCatalogueOwner('https://rezics.com/schemes/bangumi/public-tags', '后宫');
    const candidates = session.bindings.candidates(owner, 'facts', { limit: 100 });
    const close = candidates
      .map((c) => ({ c, command: JSON.parse(c.bytes).commands[0] as Extract<BatchCommand, { op: 'propose' }> }))
      .find((r) => r.command.statement.property.id === 'skos:closeMatch')!;
    const retracted = await port.batch({
      commands: [
        {
          op: 'retract',
          key: randomUUID(),
          source: close.command.source,
          subject: close.c.subject,
          candidate: close.c.candidate,
          references: close.command.statement.references,
        },
      ],
    });
    expect(retracted.results[0]!.status).toBe(200);
    expect(await readReviewedBangumiBinding(session.bindings, port)).toBeNull();
    const graph = await port.readReviewedSubject(close.c.subject);
    expect(
      'subject' in graph && graph.subject.statements['skos:closeMatch']?.some((s) => s.id === close.c.candidate),
    ).toBe(true);
    await f.grant('steward', ['moderation:hide'], GLOBAL_CONTEXT);
    const hidden = await f.request(
      'steward',
      'POST',
      `/v1/subjects/${close.c.subject}:hide`,
      { reason: 'Current original disclosure control' },
      discoveryKey(),
    );
    expect(hidden.status).toBe(200);
    expect(await readReviewedBangumiBinding(session.bindings, port)).toBeNull();
  } finally {
    session.close();
  }
}, 120_000);
