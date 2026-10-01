import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { DISCLOSURE_CHANNELS, DisclosureStore, configureDisclosure, disclosurePoolReader, disclose,
  type DisclosureTarget } from '../src/modules/disclosure/read.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import { ANONYMOUS_VIEWER, type Labels, type Viewer } from '../src/modules/suitability/policy.ts';
import { disclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { disclosureMedia } from '../src/modules/disclosure/assembly.ts';
import type { MediaStore } from '../src/modules/media/store.ts';
import { discloseExportPlan } from '../src/modules/export/readers.ts';
import { planExport } from '../src/modules/export/planner.ts';
import { feedTombstone } from '../src/modules/feed/read.ts';
import { feedItem, type FeedItem } from '../src/modules/feed/contract.ts';
import { Value } from 'typebox/value';
import { searchCardReadDependencies } from '../src/modules/search/card-reads.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import type { PublicTextPosition } from '../src/modules/work/search-readiness.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { discloseNotifications } from '../src/modules/disclosure/notifications.ts';
import { GovernanceStore } from '../src/modules/governance/store.ts';
import { RealmReplyThreadStore } from '../src/modules/realm-reply/thread-store.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixtures: DisclosureTarget[] = [
  { owner: 'graph', resource: id(1), component: 'name', revision: id(11) },
  { owner: 'content', resource: id(2), component: 'body', revision: id(12).slice(-36) },
  { owner: 'content', resource: id(3), component: 'body', revision: id(13).slice(-36) },
  { owner: 'content', resource: id(4), component: 'body', revision: id(14).slice(-36) },
  { owner: 'media', resource: id(5), component: 'cover' },
];
function storage() {
  let restricted = false, labels: Labels[] = [], open = true, malformed = false;
  let ownerQueries = 0;
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open }] };
    if (sql.includes('WITH requested')) {
      ownerQueries++;
      const targets = JSON.parse(String(args![0])) as { ordinal: number }[];
      return { rows: malformed ? [] : targets.map(target => ({ ordinal: target.ordinal, restricted, assessments: labels })) };
    }
    return { rows: [] };
  } }) } as unknown as Pool;
  return { pool, set: (state: { restricted?: boolean; labels?: Labels[]; open?: boolean; malformed?: boolean }) => {
    if (state.restricted !== undefined) restricted = state.restricted;
    if (state.labels !== undefined) labels = state.labels;
    if (state.open !== undefined) open = state.open;
    if (state.malformed !== undefined) malformed = state.malformed;
  }, queries: () => ownerQueries };
}

test('G-542: every channel combines the same removal and suitability batch for five owner grains', async () => {
  const s = storage(), reader = new DisclosureStore(s.pool);
  const adult: Viewer = { signedIn: true, age: 'adult', country: 'US', optIns: { sexual: true, grotesque: true } };
  for (const channel of DISCLOSURE_CHANNELS) {
    const before = s.queries();
    expect(await reader.read(fixtures, ANONYMOUS_VIEWER, channel)).toEqual(fixtures.map(() => 'visible'));
    expect(s.queries() - before).toBe(1);
    s.set({ restricted: true });
    expect((await reader.read(fixtures, adult, channel)).every(decision => decision !== 'visible')).toBe(true);
    s.set({ restricted: false });
    expect(await reader.read(fixtures, ANONYMOUS_VIEWER, channel)).toEqual(fixtures.map(() => 'visible'));
    for (const labels of [['r18'], ['r18g'], ['r18', 'r18g']] as Labels[]) {
      s.set({ labels: [labels] });
      for (const viewer of [ANONYMOUS_VIEWER, disclosureViewer({ issuer: 'account', subject: 'reader' })]) {
        expect((await reader.read(fixtures, viewer, channel)).every(decision => decision !== 'visible')).toBe(true);
      }
      if (['email', 'push', 'digest', 'preview', 'seo', 'sitemap', 'search', 'typeahead', 'count'].includes(channel)) {
        expect((await reader.read(fixtures, adult, channel)).every(decision => decision !== 'visible')).toBe(true);
      }
    }
    s.set({ labels: [] });
  }
});

test('G-542: configured recovery and incomplete results fail closed; absent governance preserves fixtures', async () => {
  const s = storage(), reader = new DisclosureStore(s.pool);
  s.set({ open: false });
  await expect(reader.read(fixtures, ANONYMOUS_VIEWER, 'read')).rejects.toThrow('Disclosure owner is unavailable');
  s.set({ open: true, malformed: true });
  await expect(reader.read(fixtures, ANONYMOUS_VIEWER, 'read')).rejects.toThrow('Disclosure result is incomplete');
  const env = { fuseki: new FusekiClient('http://graph.invalid'), objectDirectory: '.temp/g-542',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  expect(await disclose(env, fixtures)).toEqual(fixtures.map(() => 'visible'));
});

test('G-542: the search graph adapter retains the live required owner across graph-client identities', async () => {
  const s = storage(), graph = new FusekiClient('http://graph.invalid');
  const env = { fuseki: graph, objectDirectory: '.temp/g-542', lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  const position = { dataEpoch: 'epoch', sequence: '1', generation: 'generation' } as PublicTextPosition;
  configureDisclosure(env, new DisclosureStore(s.pool));
  const adapt = () => searchGraphSnapshot.run({ clients: new Set([graph]), lineage: env.lineage, position },
    () => searchCardReadDependencies({ environment: env } as MainWorkDependencies));
  const deps = adapt();
  expect(deps.environment.fuseki).not.toBe(graph);
  expect(await disclose(deps.environment, fixtures)).toEqual(fixtures.map(() => 'visible'));
  s.set({ restricted: true });
  expect((await disclose(deps.environment, fixtures)).every(decision => decision !== 'visible')).toBe(true);
  configureDisclosure(env, null);
  expect(await disclose(adapt().environment, fixtures)).toEqual(fixtures.map(() => 'visible'));
});

test('G-542: summary assembly keeps unavailable entries in position and never hydrates a restricted name', async () => {
  const s = storage(), graph = new FusekiClient('http://graph.invalid');
  graph.query = async () => ({ results: { bindings: fixtures.slice(0, 1).map(target => ({
    epoch: { type: 'literal', value: 'epoch' }, sequence: { type: 'literal', value: '1' },
    r: { type: 'uri', value: target.resource }, work: { type: 'uri', value: target.resource },
    type: { type: 'literal', value: 'work' }, head: { type: 'uri', value: target.revision! },
    public: { type: 'literal', value: 'true' }, label: { type: 'literal', value: 'Secret Work', 'xml:lang': 'en' },
  })) } });
  const env = { fuseki: graph, objectDirectory: '.temp/g-542', lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(env, new DisclosureStore(s.pool));
  let wikiAllows = true;
  const read = () => readResourceSummaries(env, undefined, {
    visibleRecords: async refs => new Set(wikiAllows ? refs : []),
  },
    { resources: [id(1), id(1)], context: DEFAULT_MEDIA_CONTEXT, language: null });
  expect((await read()).summaries.every(summary => summary.status === 'available')).toBe(true);
  wikiAllows = false;
  expect((await read()).summaries.every(summary => summary.status === 'unavailable')).toBe(true);
  wikiAllows = true;
  s.set({ restricted: true });
  const result = await read();
  expect(result.summaries).toEqual([{ reference: id(1), status: 'unavailable' }, { reference: id(1), status: 'unavailable' }]);
  expect(JSON.stringify(result)).not.toContain('Secret Work');
  configureDisclosure(env, null);
  expect((await read()).summaries.every(summary => summary.status === 'available')).toBe(true);
});

test('G-542: two Governance stores on one pool retain current heads for notices and reply counts', async () => {
  const oldHead = id(11), newHead = id(12);
  let current = oldHead;
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('WITH requested')) {
      const targets = JSON.parse(String(args![0])) as (DisclosureTarget & { ordinal: number })[];
      return { rows: targets.map(target => ({ ordinal: target.ordinal,
        restricted: target.resource === id(1) && target.component === 'name'
          && (target.revision == null || target.revision === oldHead)
          || target.work === id(1) && (target.workRevision == null || target.workRevision === oldHead),
        assessments: [] })) };
    }
    return { rows: [] };
  } }) } as unknown as Pool;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async () => ({ results: { bindings: [{ work: { type: 'uri', value: id(1) },
    head: { type: 'uri', value: current } }] } });
  const env = { fuseki: graph, objectDirectory: '.temp/g-542', lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  const createOwner = () => new GovernanceStore(pool, { capture: async () => { throw new Error('capture is unused'); } },
    { current: async () => null }, { current: async () => null });
  const first = createOwner();
  configureDisclosure(env, first.disclosure);
  const second = createOwner();
  expect(second.disclosure).not.toBe(first.disclosure);
  expect(disclosurePoolReader(pool)).toBe(second.disclosure);
  expect(second.disclosure.environment).toBe(env);
  const replies = new RealmReplyThreadStore({ query: async () => ({ rows: [{ thread: id(3),
    id: id(4), root_target: id(1), visible: true }] }) } as unknown as Pool, pool);
  const subjects = [{ input: { principalId: id(2).slice(-36), owner: 'graph', ref: id(1), revision: oldHead,
    disclosureBasis: 'g-542' }, result: { status: 'available' as const,
    subject: { private: false, fields: { title: 'Current Work title', linkTarget: id(1) } } } }];
  for (const channel of ['inbox', 'digest', 'email', 'push'] as const) {
    expect((await discloseNotifications(pool, subjects, channel))[0]?.status).toBe('undisclosed');
  }
  expect((await replies.counts(id(5), [id(3)])).counts.get(id(3))).toBe(0);
  current = newHead;
  for (const channel of ['inbox', 'digest', 'email', 'push'] as const) {
    expect((await discloseNotifications(pool, subjects, channel))[0]?.status).toBe('available');
  }
  expect((await replies.counts(id(5), [id(3)])).counts.get(id(3))).toBe(1);
});

test('G-542: asset adapters and export manifests discard all denied payload and notices', async () => {
  const s = storage(), graph = new FusekiClient('http://graph.invalid');
  graph.query = async () => ({ results: { bindings: [{ work: { type: 'uri', value: id(1) },
    head: { type: 'uri', value: id(11) } }] } });
  const env = { fuseki: graph, objectDirectory: '.temp/g-542', lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(env, new DisclosureStore(s.pool));
  const asset = { asset: id(5).slice(-36), target: id(1), context: DEFAULT_MEDIA_CONTEXT,
    selection: id(11).slice(-36), selectionPosition: null, use: id(12).slice(-36), crop: null,
    representation: id(13).slice(-36), sha256: 'b'.repeat(64), mediaType: 'image/png', byteLength: 100,
    width: 1, height: 1, availability: 'available', disclosure: 'public', moderation: 'none',
    lifecycle: 'active', clearance: 'cleared' as const, owner: id(2), uploader: id(2),
    statePosition: null, objectNamespace: 'native' };
  const store = disclosureMedia({ avatarDelivery: async () => asset,
    assetDelivery: async () => asset, itemDelivery: async () => asset } as unknown as MediaStore, env);
  const avatar = () => store.avatarDelivery(id(11).slice(-36));
  const delivery = () => store.assetDelivery(id(5).slice(-36), id(1), DEFAULT_MEDIA_CONTEXT);
  const item = () => store.itemDelivery(id(12).slice(-36));
  const plan = await planExport({ targetProfile: 'g-542-export-v1', useScope: 'full', residuals: [],
    members: [{ sourceOwner: 'graph', sourceNamespace: 'product', sourceGrain: 'work',
      exactRef: id(11), contentRevisionId: null, refDigest: 'a'.repeat(64), ownerDataEpoch: 'epoch',
      ownerSequence: '1', sourcePosition: null, targetGrain: 'Work', mapping: 'exact',
      value: { kind: 'text', lexical: 'Secret words', language: 'en' }, data: { work: id(1), title: 'Secret title' } }] },
  async () => [{ basisKind: 'unprotected_fact', basisRef: null, licenseExpression: null, notice: 'Secret notice',
    obligations: [], useScope: 'full', result: 'undetermined', memberOrdinals: [1] }]);
  expect(await avatar()).toBe(asset);
  expect(await delivery()).toBe(asset);
  expect(await item()).toBe(asset);
  expect(await discloseExportPlan(env, plan, ANONYMOUS_VIEWER)).toBe(plan);
  s.set({ restricted: true });
  expect(await avatar()).toBeNull();
  expect(await delivery()).toBeNull();
  expect(await item()).toBeNull();
  const omitted = await discloseExportPlan(env, plan, ANONYMOUS_VIEWER);
  expect(JSON.stringify(omitted)).not.toContain('Secret');
  expect(omitted.members[0]?.data).toEqual({ omitted: 'disclosure_restricted' });
  expect(omitted.members[0]?.value).toBeUndefined();
  expect(omitted.residuals.some(loss => loss.memberOrdinal === 1 && loss.kind === 'private_dependency')).toBe(true);
  expect(omitted.completeness).toBe('partial');
  s.set({ restricted: false, labels: [['r18g']] });
  expect(await avatar()).toBeNull();
  expect(await delivery()).toBeNull();
  expect(await item()).toBeNull();
  expect(JSON.stringify(await discloseExportPlan(env, plan, ANONYMOUS_VIEWER))).not.toContain('Secret');
  const incomplete = disclosureMedia({ itemDelivery: async () => ({ target: id(1) }) } as unknown as MediaStore, env);
  expect(await incomplete.itemDelivery(id(12).slice(-36))).toBeNull();
  s.set({ labels: [] });
  expect(await incomplete.itemDelivery(id(12).slice(-36))).toMatchObject({ target: id(1) });
});

test('G-542: feed tombstones preserve identity/time and erase card, author, counts and reader-state payloads', () => {
  const item: FeedItem = { id: id(1), kind: 'reply', actor: { id: id(2), name: 'Secret author', handle: 'Secret handle' },
    authors: [], post: { title: 'Secret post', excerpt: 'Secret words', language: 'en' },
    reason: { kind: 'recommended', basis: 'all' }, reasons: [], card: { kind: 'activity' },
    primaryAction: { kind: 'open', href: '/Secret' }, viewerState: { status: 'available', shelf: null,
      progress: null, spoiler: { policy: 'show', hidden: false } },
    group: { key: 'Secret group', count: 2, actors: [{ id: id(2), name: 'Secret', handle: 'Secret' }] },
    target: { id: id(3), work: id(3), title: { value: 'Secret Work', language: 'en', direction: 'ltr', basis: 'requested' },
      cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'Secret image', resourceType: 'work' },
      types: [], excerpt: 'Secret excerpt', language: 'en' }, realm: null,
    time: '2026-10-01T00:00:00Z', timeBasis: 'revision', score: 200, vote: 1, voteRevision: null,
    comments: { value: 5, kind: 'exact' }, links: { target: '/Secret', actor: '/Secret', comments: '/Secret', vote: '/Secret' } };
  const tombstone = feedTombstone(item);
  expect(Value.Check(feedItem, tombstone)).toBe(true);
  expect([tombstone.id, tombstone.time]).toEqual([item.id, item.time]);
  expect(JSON.stringify(tombstone)).not.toContain('Secret');
  expect(tombstone.score).toBe(0);
  expect(tombstone.comments.value).toBe(0);
  expect(tombstone.viewerState).toEqual({ status: 'unavailable' });
});

test('G-542: each composed channel has a final shared gate; optional legacy fences cannot replace it', () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  for (const [path, call] of [
    ['modules/media/summary.ts', 'await discloseInventory('],
    ['modules/disclosure/assembly.ts', 'discloseContent(env, await target.readExactBatch('],
    ['modules/feed/read.ts', "session.disclosure(fenceTargets, 'feed')"],
    ['modules/realm-reply/thread-read.ts', 'await discloseInventory(session.deps.environment, heads.map('],
    ['modules/realm-reply/store.ts', 'await discloseInventory('],
    ['modules/realm-reply/thread-store.ts', 'await reader.read('],
    ['modules/search/fields.ts', 'await discloseSearchMatches('],
    ['modules/search/card-reads.ts', 'const environment = { ...deps.environment, fuseki: client }'],
    ['modules/work/search-public.ts', 'await discloseSearchMatches('],
    ['modules/work/search-multifield.ts', 'await discloseSearchMatches('],
    ['modules/search-disclosure/public-fields.ts', 'await discloseInventory('],
    ['modules/disclosure/sitemap.ts', 'await assembleSitemapEntries('],
    ['modules/notification/store.ts', 'await discloseNotifications('],
    ['modules/notification/dispatcher.ts', 'await discloseNotifications('],
    ['modules/notification/digest.ts', 'resolveDigestSubjects(inputs)'],
    ['modules/export/readers.ts', 'return discloseExportPlan('],
  ]) expect(source(path!)).toContain(call!);
  expect(source('app.ts')).toContain('if (work) composeDisclosure(work)');
  expect(source('routes/resources.ts')).toContain('await readSitemap(work.environment, query.after)');
  expect(source('modules/disclosure/read.ts')).toContain("const owner = Symbol('disclosureOwner')");
  expect(source('modules/media/summary.ts')).not.toContain('await reader.restrictedTitles(');
});
