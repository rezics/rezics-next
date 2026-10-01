import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure, discloseInventory, DisclosureStore,
  type DisclosureTarget } from '../src/modules/disclosure/read.ts';
import { disclosureContent, disclosureMedia } from '../src/modules/disclosure/assembly.ts';
import { currentDisclosureViewer, disclosureViewer, withDisclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { ANONYMOUS_VIEWER, type Labels, type Viewer } from '../src/modules/suitability/policy.ts';
import { publicTargetRead, targetSummaries, type TargetReadSession } from '../src/modules/target/resolve.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT, type MediaStore } from '../src/modules/media/store.ts';
import { admittedPublicWorks } from '../src/modules/work/public-patterns.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import { readWorkStats, type WorkReaderStats } from '../src/modules/work/read-stats.ts';
import { canReadCompositionWork } from '../src/modules/composition/disclosure-read.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { discloseExportPlan } from '../src/modules/export/readers.ts';
import { planExport } from '../src/modules/export/planner.ts';
import type { ContentCore } from '../../content/src/core.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const adult: Viewer = { signedIn: true, age: 'adult', country: 'US', optIns: { sexual: true, grotesque: true } };

function fixture() {
  const labels = new Map<string, Labels>();
  let failed = false, ownerQueries = 0;
  const requested: DisclosureTarget[][] = [];
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('WITH requested')) {
      ownerQueries++;
      if (failed) throw new Error('Assessment store unavailable');
      const targets = JSON.parse(String(args![0])) as (DisclosureTarget & { ordinal: number })[];
      requested.push(targets);
      return { rows: targets.map(target => ({ ordinal: target.ordinal, restricted: false,
        assessments: [...new Set([target.resource, target.work])]
          .flatMap(ref => ref && labels.has(ref) ? [labels.get(ref)!] : []) })) };
    }
    return { rows: [] };
  } }) } as unknown as Pool;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    if (query.includes('SELECT ?epoch ?sequence WHERE')) return { results: { bindings: [{
      epoch: term('epoch'), sequence: term('1'),
    }] } };
    if (query.includes('SELECT ?work ?head')) {
      const refs = [...query.matchAll(/<https:\/\/rezics\.com\/id\/[0-9a-f-]{36}>/g)]
        .map(match => match[0].slice(1, -1));
      return { results: { bindings: refs.map(work => ({ work: term(work), head: term(id(11)),
        ...(work === id(2) ? { owningWork: term(id(1)), owningHead: term(id(11)) } : {}) })) } };
    }
    return { results: { bindings: [1, 2].map(n => ({
      epoch: term('epoch'), sequence: term('1'), r: term(id(n)), work: term(id(1)),
      type: term(n === 1 ? 'work' : 'release'), head: term(id(11)), public: term('true'),
      label: { ...term('Secret name'), 'xml:lang': 'en' },
    })) } };
  };
  const environment = { fuseki: graph, objectDirectory: '.temp/g-897',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, new DisclosureStore(pool));
  return { environment, labels, requested, queries: () => ownerQueries, fail: () => { failed = true; } };
}

test('G-897: target and owning-Work assessments compose before name/media hydration and preserve absent envelopes', async () => {
  const f = fixture();
  let hydrations = 0;
  const media = { avatarRows: async () => { hydrations++; throw new Error('Hidden media was hydrated'); } } as unknown as MediaStore;
  f.labels.set(id(1), ['r18']);
  const input = { resources: [id(1), id(2), id(1)], context: DEFAULT_MEDIA_CONTEXT, language: null };
  const hidden = await readResourceSummaries(f.environment, media, {}, input);
  expect(hidden.summaries).toEqual(input.resources.map(reference => ({ reference, status: 'unavailable' })));
  expect(hidden.generation.media).toBeNull();
  expect(hidden.cost.mediaQueries).toBe(0);
  expect(hydrations).toBe(0);
  expect(f.queries()).toBe(1);
  const missing = await readResourceSummaries(f.environment, media, {}, { ...input, resources: [id(99)] });
  expect(missing.cost).toEqual(hidden.cost);
  f.labels.set(id(1), []);
  f.labels.set(id(2), ['r18g']);
  const separate = await readResourceSummaries(f.environment, undefined, {}, input);
  expect(separate.summaries.map(summary => summary.status)).toEqual(['available', 'unavailable', 'available']);
});

test('G-897: admitted owner evidence reaches the target reader while preview and indexing stay anonymous', async () => {
  const f = fixture();
  f.labels.set(id(1), ['r18', 'r18g']);
  const session = { deps: { environment: f.environment }, principal: null,
    options: {}, displayLanguages: ['en'], viewer: adult } as unknown as TargetReadSession;
  expect((await targetSummaries(session, [id(2)])).summaries[0]?.status).toBe('available');
  for (const viewer of [ANONYMOUS_VIEWER, disclosureViewer({ issuer: 'account', subject: 'reader' }),
    { ...adult, country: 'GB' }, { ...adult, optIns: { sexual: true, grotesque: false } }]) {
    expect((await targetSummaries({ ...session, viewer }, [id(2)])).summaries[0]?.status).toBe('unavailable');
  }
  for (const channel of ['preview', 'sitemap', 'seo'] as const) {
    expect((await readResourceSummaries(f.environment, undefined, { viewer: adult }, {
      resources: [id(2)], context: DEFAULT_MEDIA_CONTEXT, language: null, channel,
    })).summaries[0]?.status).toBe('unavailable');
  }
  f.labels.clear();
  expect((await targetSummaries({ ...session, viewer: ANONYMOUS_VIEWER }, [id(2)])).summaries[0]?.status).toBe('available');
  f.labels.set(id(1), ['r15']);
  expect((await targetSummaries({ ...session, viewer: { ...adult, age: '15-17' } }, [id(2)])).summaries[0]?.status).toBe('available');
});

test('G-897: identity-only derivatives infer the current owning Work in the shared batch and fail closed on outage', async () => {
  const f = fixture();
  f.labels.set(id(1), ['r18']);
  expect(await discloseInventory(f.environment, [{ owner: 'graph', resource: id(2), component: 'record' }],
    ANONYMOUS_VIEWER, 'read')).toEqual(['tombstone']);
  expect(f.requested.at(-1)?.[0]).toMatchObject({ work: id(1), workRevision: id(11) });
  expect(await admittedPublicWorks(f.environment, [id(1)], adult)).toEqual(new Set([id(1)]));
  f.fail();
  await expect(discloseInventory(f.environment, [{ owner: 'graph', resource: id(2), component: 'record' }],
    adult, 'read')).rejects.toThrow('Disclosure owner is unavailable');
  await expect(readResourceSummaries(f.environment, undefined, { viewer: adult }, {
    resources: [id(2)], context: DEFAULT_MEDIA_CONTEXT, language: null,
  })).rejects.toThrow('Disclosure owner is unavailable');
});

test('G-897: graph-only public target resolution retains the configured assessment owner', async () => {
  const f = fixture();
  f.labels.set(id(1), ['r18']);
  const result = await publicTargetRead(f.environment.fuseki, session => targetSummaries(session, [id(1)]));
  expect(result.summaries[0]?.status).toBe('unavailable');
  f.fail();
  await expect(publicTargetRead(f.environment.fuseki, session => targetSummaries(session, [id(1)])))
    .rejects.toThrow('Disclosure owner is unavailable');
});

test('G-897: graph publication and explicit Access grants cannot bypass composition or reader counts', async () => {
  const f = fixture();
  f.environment.fuseki.query = async () => ({ results: { bindings: [{ work: term(id(1)), head: term(id(11)) }] } });
  const deps = { environment: f.environment, access: { canReadWork: async () => true } } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.local/v1/works'), { actingSubject: id(9) },
    { dataEpoch: 'epoch', sequence: '1' });
  session.principal = { issuer: 'account', subject: 'reader' };
  session.query = async () => [{ main: term(id(10)), public: term('true') }];
  let counted = 0;
  const stats = { readerCounts: async () => { counted++; return { reading: { value: 8, kind: 'exact' },
    wantToRead: { value: 5, kind: 'exact' } }; } } as unknown as WorkReaderStats;
  f.labels.set(id(1), ['r18']);
  expect(await canReadCompositionWork(session, id(1))).toBe(false);
  await expect(readWorkStats(session, id(1), undefined, stats)).rejects.toThrow('Work is unavailable');
  expect(counted).toBe(0);
  f.labels.clear();
  expect(await canReadCompositionWork(session, id(1))).toBe(true);
  expect((await readWorkStats(session, id(1), undefined, stats)).reading.value).toBe(8);
  expect(counted).toBe(1);
});

test('G-897: concurrent Content/media readers retain isolated evidence and exports inherit omitted parent gates', async () => {
  const f = fixture();
  f.labels.set(id(1), ['r18']);
  const asset = { asset: id(5).slice(-36), target: id(2), sha256: 'a'.repeat(64), mediaType: 'image/png',
    byteLength: 20, width: 1, height: 1, availability: 'available', clearance: 'cleared' as const,
    disclosure: 'public', moderation: 'none', lifecycle: 'active', objectNamespace: 'native' };
  const media = disclosureMedia({ itemDelivery: async () => asset } as unknown as MediaStore, f.environment);
  const content = disclosureContent({ readExactBatch: async () => [{ revisionId: id(6).slice(-36), status: 'available',
    reference: { resourceId: id(1) }, body: { body: 'Secret body' } }] } as unknown as ContentCore, f.environment);
  const read = (viewer: Viewer) => withDisclosureViewer(viewer, async () => {
    await Promise.resolve();
    return { media: await media.itemDelivery(id(8).slice(-36)),
      content: await content.readExactBatch([id(6).slice(-36)], async ids => new Set(ids)) };
  });
  const [admitted, denied] = await Promise.all([read(adult), read(ANONYMOUS_VIEWER)]);
  expect(admitted.media).toBe(asset);
  expect(admitted.content[0]?.status).toBe('available');
  expect(denied.media).toBeNull();
  expect(denied.content[0]?.status).toBe('denied');
  expect(currentDisclosureViewer()).toBe(ANONYMOUS_VIEWER);
  const plan = await planExport({ targetProfile: 'g-897-export-v1', useScope: 'full', residuals: [],
    members: [{ sourceOwner: 'graph', sourceNamespace: 'product', sourceGrain: 'external_release', exactRef: id(2),
      contentRevisionId: null, refDigest: 'a'.repeat(64), ownerDataEpoch: 'epoch', ownerSequence: '1',
      sourcePosition: null, targetGrain: 'Release', mapping: 'exact', data: { resource: id(2), title: 'Secret release' } }] }, async () => []);
  expect(JSON.stringify(await discloseExportPlan(f.environment, plan, ANONYMOUS_VIEWER))).not.toContain('Secret');
  expect(await discloseExportPlan(f.environment, plan, adult)).toBe(plan);
});
