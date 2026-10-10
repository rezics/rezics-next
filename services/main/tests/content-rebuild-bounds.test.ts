import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { CONTENT_REBUILD_PAGE, CONTENT_REBUILD_READ_BUDGET_MS, ContentRebuildUnavailable,
  contentRebuildFailureLine, verifyQuarantinedContentIndex }
  from '../src/modules/content-publication/rebuild.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { startSearchFuseki } from '../../../scripts/operations/search-startup.ts';

const graphEpoch = '11111111-1111-4111-8111-111111111111';
const sourceEpoch = '22222222-2222-4222-8222-222222222222';
const generation = 'urn:rezics:text-index-generation:33333333-3333-4333-8333-333333333333';
const binding = (value: string, language?: string) => ({ type: language ? 'literal' : 'uri',
  value, ...(language ? { 'xml:lang': language } : {}) });

function variantId(index: number): string {
  return `urn:rezics:variant:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function revisionId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function afterLiteral(sparql: string, variable: string): string {
  const match = sparql.match(new RegExp(`FILTER\\(STR\\(\\?${variable}\\) > (".*")\\)`));
  return match ? JSON.parse(match[1]!) as string : '';
}

function page<T extends { id: string }>(items: readonly T[], after: string): T[] {
  return items.filter(item => item.id > after)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .slice(0, CONTENT_REBUILD_PAGE);
}

interface FixtureOptions {
  count?: number;
  missingHead?: number;
  population?: string;
  timeoutOn?: string;
}

function verifyFixture(options: FixtureOptions = {}) {
  const count = options.count ?? 1;
  const records = Array.from({ length: count }, (_, index) => {
    const variant = variantId(index);
    const revision = `urn:rezics:content:revision:${revisionId(index)}`;
    return { id: variant, variant, resource: `https://rezics.com/id/${revisionId(index)}`,
      revision, revisionId: revisionId(index),
      decision: `urn:rezics:content-publication:${String(index).padStart(64, 'a')}`,
      eligibility: `urn:rezics:content-search-eligibility:${String(index).padStart(64, 'b')}`,
      unit: `urn:rezics:content:match-unit:${String(index).padStart(64, '0')}`,
      digest: 'd'.repeat(64), text: `body ${index}` };
  });
  const queries: string[] = [];
  const fuseki = { async query(sparql: string): Promise<SparqlResult> {
    queries.push(sparql);
    if (options.timeoutOn && sparql.includes(options.timeoutOn)) {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    if (sparql.includes('ASK { GRAPH <urn:rezics:search:public>')) return { boolean: false };
    if (sparql.includes('ASK { GRAPH <urn:rezics:graph:receipts>')) return { boolean: true };
    if (sparql.includes('SELECT ?epoch ?routing')) return { results: { bindings: [{
      epoch: binding(graphEpoch), routing: binding(graphEpoch), sequence: binding('3'),
      generation: binding(generation),
    }] } };
    if (sparql.includes('SELECT ?variant WHERE')) {
      const rows = page(records, afterLiteral(sparql, 'variant'));
      return { results: { bindings: rows.map(row => ({ variant: binding(row.variant) })) } };
    }
    if (sparql.includes('SELECT ?variant ?resource')) {
      const asked = [...(sparql.match(/VALUES \?variant \{([^}]*)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
        .map(match => match[1]!);
      const rows = records.filter(row => asked.includes(row.variant) && row.id !== variantId(options.missingHead ?? -1));
      return { results: { bindings: rows.map(row => ({ variant: binding(row.variant),
        resource: binding(row.resource), decision: binding(row.decision),
        eligibility: binding(row.eligibility), revision: binding(row.revision), digest: binding(row.digest) })) } };
    }
    if (sparql.includes('SELECT ?unit ?body')) {
      const rows = page(records.map(row => ({ ...row, id: row.unit })), afterLiteral(sparql, 'unit'));
      return { results: { bindings: rows.map(row => ({ unit: binding(row.unit), body: binding(row.text, 'en'),
        resource: binding(row.resource), variant: binding(row.variant), revision: binding(row.revision),
        decision: binding(row.decision), eligibility: binding(row.eligibility) })) } };
    }
    if (sparql.includes('publicTextInventory()')) {
      return { results: { bindings: [{ population: binding(options.population ?? String(count)) }] } };
    }
    if (sparql.includes('ASK { GRAPH <urn:rezics:search:probe>')) return { boolean: true };
    throw new Error(`unexpected rebuild query: ${sparql.slice(0, 160)}`);
  } } as unknown as WorkActivationEnvironment['fuseki'];
  const position = { owner: 'content' as const, dataEpoch: sourceEpoch, sequence: '3' };
  const content = { ownerPosition: async () => position,
    readExactBatch: async (ids: string[]) => ids.map(id => {
      const record = records.find(item => item.revisionId === id)!;
      return { status: 'available' as const, reference: { variantId: record.variant,
        resourceId: record.resource, byteDigest: record.digest, model: 'content-shape-v1',
        language: { kind: 'tag' as const, tag: 'en' } }, body: { body: record.text } };
    }),
  } as unknown as ContentCore;
  const cursor = { read: async () => position } as unknown as ContentProjectionCursor;
  const run = verifyQuarantinedContentIndex({ fuseki,
    lineage: { dataEpoch: graphEpoch, routingEpoch: graphEpoch }, objectDirectory: '' },
  content, cursor, { id: graphEpoch, cut: position, consumer: 'content-rebuild.fixture' });
  return { run, queries };
}

test('rebuild verification pages variants and binds each receipt join', async () => {
  const count = CONTENT_REBUILD_PAGE + 1;
  const { run, queries } = verifyFixture({ count });
  expect(await run).toMatchObject({ unitCount: count, contentUnitCount: count });
  const declared = queries.filter(query => query.includes('SELECT ?variant WHERE'));
  const heads = queries.filter(query => query.includes('urn:rezics:graph:revisions')
    && query.includes('urn:rezics:graph:receipts'));
  const units = queries.filter(query => query.includes('SELECT ?unit ?body'));
  expect(declared).toHaveLength(2);
  expect(declared[1]).toContain('FILTER(STR(?variant) >');
  expect(declared.every(query => query.includes(`ORDER BY STR(?variant)`)
    && query.includes(`LIMIT ${CONTENT_REBUILD_PAGE}`))).toBe(true);
  expect(heads).toHaveLength(2);
  for (const query of heads) {
    expect(query).toContain('VALUES ?variant');
    expect(query).toContain(`LIMIT ${CONTENT_REBUILD_PAGE}`);
    expect(query).toContain('?publicationReceipt rv:variant ?variant');
    expect(query).toContain('?eligibilityReceipt rv:variant ?variant');
    expect(query).not.toContain(`LIMIT ${50_001}`);
  }
  expect(units).toHaveLength(2);
  expect(units.every(query => query.includes('ORDER BY STR(?unit)')
    && query.includes(`LIMIT ${CONTENT_REBUILD_PAGE}`))).toBe(true);
  expect(queries.some(query => query.includes('urn:rezics:graph:revisions')
    && !query.includes('VALUES ?variant'))).toBe(false);
  expect(CONTENT_REBUILD_READ_BUDGET_MS).toBeLessThan(10_000);
});

test('a variant with no public head still fails the rebuild', async () => {
  const { run } = verifyFixture({ missingHead: 0 });
  await expect(run).rejects.toThrow(ContentRebuildUnavailable);
  await expect(verifyFixture({ missingHead: 0 }).run).rejects.toThrow(
    'declared eligibility inventory differs from exact public heads');
});

test('a timed out verification read names its step and page', async () => {
  await expect(verifyFixture({ timeoutOn: 'SELECT ?variant ?resource' }).run)
    .rejects.toThrow('heads page 0: timed out');
  await expect(verifyFixture({ timeoutOn: 'SELECT ?variant WHERE' }).run)
    .rejects.toThrow('declared page 0: timed out');
  await expect(verifyFixture({ timeoutOn: 'SELECT ?unit ?body' }).run)
    .rejects.toThrow('units page 0: timed out');
  await expect(verifyFixture({ timeoutOn: 'publicTextInventory()' }).run)
    .rejects.toThrow('inventory: timed out');
  const timeout = new DOMException('The operation timed out.', 'TimeoutError');
  expect(contentRebuildFailureLine(timeout)).toBe('rebuild: timed out');
  expect(contentRebuildFailureLine(new ContentRebuildUnavailable('heads page 0: timed out')))
    .toBe('heads page 0: timed out');
});

test('a Fuseki startup timeout names the wait', async () => {
  const error = new Error('spawnSync docker ETIMEDOUT');
  await expect(startSearchFuseki(import.meta.dir, process.env, 'dev', () => { throw error; }))
    .rejects.toThrow('startup wait: timed out');
});
