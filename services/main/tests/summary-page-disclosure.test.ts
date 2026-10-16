import { expect, test } from 'bun:test';
import { configureFixtureDisclosureAncestry, fixtureDisclosureCut } from './support/disclosure-ancestry.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure, type DisclosureDecision, type DisclosureTarget } from '../src/modules/disclosure/read.ts';
import { readFeed } from '../src/modules/feed/read.ts';
import { mainFeedPosition } from '../src/modules/feed/frame.ts';
import type { FeedRow } from '../src/modules/feed/store.ts';
import { DEFAULT_MEDIA_CONTEXT, type AvatarRow } from '../src/modules/media/store.ts';
import type { ResourceSummary } from '../src/modules/media/summary.ts';
import { readRankings } from '../src/modules/rankings/read.ts';
import type { ReadRankingProjection } from '../src/modules/rankings/projection.ts';
import { RV } from '../src/modules/work/activate.ts';
import { WorkReadSession, type ReadRow } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = id(1);
const actor = id(2);
const activity = id(10);
const head = id(1001);
const term = (value: string) => ({ type: 'literal' as const, value });
const uri = (value: string) => ({ type: 'uri' as const, value });
const title = 'Signed only title';

/** A signed viewer may receive the name, and must not be told it is public.
 * A cover the same viewer may not see stays off the card. */
type Case = 'cover' | 'name';

function avatar(target: string): AvatarRow {
  return { target, context: DEFAULT_MEDIA_CONTEXT, selection: id(501).slice(-36), selectionPosition: '1',
    use: id(502).slice(-36), asset: id(503).slice(-36), representation: id(504).slice(-36),
    sha256: 'a'.repeat(64), crop: null, mediaType: 'image/png', byteLength: 100, width: 128, height: 128,
    availability: 'available', clearance: 'cleared', disclosure: 'public', moderation: 'none',
    lifecycle: 'active', statePosition: '1' };
}

function page(kind: Case) {
  const evaluated: Array<{ paired: boolean; targets: DisclosureTarget[] }> = [];
  const decide = (targets: readonly DisclosureTarget[], paired: boolean) => {
    expect(targets.every(target => target.ancestry !== undefined)).toBe(true);
    evaluated.push({ paired, targets: [...targets] });
    const decisions = targets.map((target): DisclosureDecision =>
      kind === 'cover' && target.owner === 'media' ? 'hidden' : 'visible');
    const anonymousNames = targets.map((target): DisclosureDecision =>
      kind === 'name' && target.owner === 'graph' && (target.component === 'name' || target.component === 'title')
        ? 'hidden' : 'visible');
    return { decisions, anonymousNames };
  };
  const graph = new FusekiClient('http://summary-page-disclosure.invalid');
  const unexpected: string[] = [];
  graph.query = async query => {
    const row = (fields: Record<string, string>) => {
      const binding: ReadRow = {};
      for (const [key, value] of Object.entries(fields)) binding[key] = key === 'label' || key === 'displayName'
        ? { ...term(value), 'xml:lang': 'en' } : uri(value);
      return binding;
    };
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const control = { epoch: term('epoch'), sequence: term('7') };
      return { results: { bindings: [control, { ...control, r: uri(work), type: term('work'), work: uri(work),
        head: uri(head), public: term('true'), label: { ...term(title), 'xml:lang': 'en' } }] } };
    }
    if (query.includes('SELECT DISTINCT ?id ?sequence')) {
      return { results: { bindings: [{ id: uri(activity), sequence: term('1'), kind: term('work'),
        target: uri(work), work: uri(work), actor: uri(actor) }] } };
    }
    if (query.includes('BIND("pointer"')) {
      return { results: { bindings: [{ part: term('pointer'), work: uri(work) }] } };
    }
    if (query.includes('SELECT ?agent ?displayName')) {
      return { results: { bindings: [row({ agent: actor, displayName: 'Poster', agentKind: `${RV}PersonAgent`,
        agentHead: head })] } };
    }
    if (query.includes('SELECT DISTINCT ?work ?main ?head')) {
      return { results: { bindings: [{ work: uri(work), main: uri(id(11)), head: uri(head) }] } };
    }
    if (query.includes('rv:descriptiveMetadataHead')) return { results: { bindings: [{ work: uri(work) }] } };
    if (query.includes('SELECT ?resource ?head')) return { results: { bindings: [{ resource: uri(work), head: uri(head) }] } };
    if (query.includes('SELECT ?work ?head ?owningWork')) {
      unexpected.push('disclosure head probe');
      throw new Error('Disclosure probed a work head the summary already read');
    }
    if (query.includes('SELECT ?resource ?structure') || query.includes('MIN(STR(?realm))')
      || query.includes('SELECT ?work ?type') || query.includes('SELECT ?epoch ?hold ?context')) {
      return { results: { bindings: [] } };
    }
    unexpected.push(query.replace(/\s+/g, ' ').slice(0, 180));
    throw new Error(`Unexpected graph query: ${unexpected.at(-1)}`);
  };
  const environment = { fuseki: graph, objectDirectory: '.temp/summary-page-disclosure',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, {
    read: async targets => decide(targets, false).decisions,
    readWithAnonymousNames: async targets => decide(targets, true),
    readAtCut: async (targets, _viewer, _channel, _client, anonymousNames) => ({
      ...decide(targets, anonymousNames === true), fenceBases: targets.map(() => fixtureDisclosureCut),
    }),
  });
  configureFixtureDisclosureAncestry(environment, target => target.work || target.resource === work
    ? { resource: target.work ?? work, head,
      ...(target.workRevision !== undefined ? { protectedRevision: target.workRevision } : {}) }
    : undefined);
  const session = new WorkReadSession({
    environment,
    access: { assertRecoveryOpen: async () => undefined, activePrincipalId: async () => actor },
    follows: {},
    personPreferences: {},
    profiles: {},
    relayPosition: { read: async () => mainFeedPosition('epoch', '7') },
    media: { store: { avatarRows: async (resources: readonly string[]) => ({
      rows: new Map(resources.map(reference => [reference, avatar(reference)])),
      generation: { owner: 'content' as const, dataEpoch: 'media', sequence: '1' },
    }) } },
    feed: homeStore(),
  } as unknown as MainWorkDependencies, new Request('http://main.local/v1/feed'), {},
    { dataEpoch: 'epoch', sequence: '7' }, true);
  session.principal = { issuer: 'account', subject: 'reader' };
  const captured: ResourceSummary[][] = [];
  const summaries = session.summaries.bind(session);
  session.summaries = async (resources, optionalMedia) => {
    const batch = await summaries(resources, optionalMedia);
    captured.push(batch);
    return batch;
  };
  return { session, captured, evaluated };
}

function homeStore() {
  const now = new Date('2026-10-10T00:00:00.000Z');
  const row: FeedRow = { id: activity, kind: 'work', occurred_at: now, time_basis: 'revision', realm: null,
    group_key: activity, group_members: [activity], sort_time: now, score: 1, order_key: '1', vote: 0,
    vote_revision: null };
  const checkpoint = { data_epoch: 'epoch', sequence: '7', after_id: '\uffff', revision: 'checkpoint',
    rebuild_epoch: null, rebuild_after: '', review_sequence: '0' };
  return {
    openFrame: async () => ({
      checkpoint, personal: null, personSettings: undefined, following: null,
      hiddenReadingActors: new Set<string>(),
      cardAccess: async (actors: readonly string[]) => ({
        actorState: { fences: new Map(actors.map(agent => [agent, '1'])), handles: new Map<string, string>() },
        matches: null, match: () => null,
      }),
      close: async () => ({ pending: false, watermark: null }),
    }),
    page: async () => [row],
    members: async () => [row],
  };
}

const delivered = (batches: ResourceSummary[][]) => batches.flat().filter(summary => summary.status === 'available');

test('home withholds a cover the viewer may not see', async () => {
  const f = page('cover');
  const feed = await readFeed(f.session, {});
  expect(feed.items).toHaveLength(1);
  expect(feed.items[0]!.target.cover.kind).toBe('fallback');
  expect(delivered(f.captured).every(summary => summary.disclosure === 'public')).toBe(true);
  const passes = f.evaluated.filter(call => call.paired && call.targets.some(target => target.component === 'name'));
  expect(passes).toHaveLength(1);
  expect(passes[0]!.targets.some(target => target.owner === 'media' && target.component === 'cover')).toBe(true);
});

test('home does not label a signed-in-only name public', async () => {
  const f = page('name');
  const feed = await readFeed(f.session, {});
  expect(feed.items.map(item => item.target.title.value)).not.toContain(title);
  const summaries = delivered(f.captured);
  expect(summaries.some(summary => summary.disclosure === 'restricted' && summary.name.value === title)).toBe(true);
  const passes = f.evaluated.filter(call => call.paired && call.targets.some(target => target.component === 'name'));
  expect(passes).toHaveLength(1);
  expect(passes[0]!.targets.some(target => target.owner === 'media' && target.component === 'cover')).toBe(true);
});

test('ranking withholds a cover the viewer may not see', async () => {
  const f = page('cover');
  const ranking = await readRankings(f.session, {
    capture: async (...args: Parameters<ReadRankingProjection['capture']>) => ({
      checkpoint: { generation: id(90).slice(-36), contentEpoch: 'epoch', contentSequence: '1',
        graphEpoch: 'epoch', reviewPosition: '1' }, revision: '1', removalRevision: '0', rows: [{ work, score: '3', growth: '1' }],
      population: { metric: args[0], interval: args[1], bucket: args[2],
        context: args[6] ?? 'urn:rezics:context:global' } }),
    fence: async () => true,
  } as unknown as ReadRankingProjection, { realm: null, metric: 'reads', interval: 'day', order: 'score' });
  expect(ranking.items).toHaveLength(1);
  expect(ranking.items[0]!.cover.kind).toBe('fallback');
  const passes = f.evaluated.filter(call => call.paired && call.targets.some(target => target.component === 'name')
    && call.targets.some(target => target.owner === 'media' && target.component === 'cover'));
  expect(passes).toHaveLength(1);
  await f.session.fenceDependencies();
  const closedPasses = f.evaluated.filter(call => call.paired && call.targets.some(target => target.component === 'name'));
  expect(closedPasses).toHaveLength(2);
  expect(closedPasses.every(call => call.targets.some(target => target.owner === 'media' && target.component === 'cover'))).toBe(true);
});

test('ranking does not label a signed-in-only name public', async () => {
  const f = page('name');
  const ranking = await readRankings(f.session, {
    capture: async (...args: Parameters<ReadRankingProjection['capture']>) => ({
      checkpoint: { generation: id(90).slice(-36), contentEpoch: 'epoch', contentSequence: '1',
        graphEpoch: 'epoch', reviewPosition: '1' }, revision: '1', removalRevision: '0', rows: [{ work, score: '3', growth: '1' }],
      population: { metric: args[0], interval: args[1], bucket: args[2],
        context: args[6] ?? 'urn:rezics:context:global' } }),
    fence: async () => true,
  } as unknown as ReadRankingProjection, { realm: null, metric: 'reads', interval: 'day', order: 'score' });
  expect(ranking.items).toEqual([]);
  expect(ranking.count).toEqual({ value: 0, kind: 'exact-page', total: null });
  expect(ranking.nextCursor).toBeNull();
  const summaries = delivered(f.captured);
  expect(summaries.some(summary => summary.disclosure === 'restricted' && summary.name.value === title)).toBe(true);
  expect(summaries.every(summary => summary.disclosure !== 'public')).toBe(true);
  const passes = f.evaluated.filter(call => call.paired && call.targets.some(target => target.component === 'name'));
  expect(passes).toHaveLength(1);
  await f.session.fenceDependencies();
  const closedPasses = f.evaluated.filter(call => call.paired && call.targets.some(target => target.component === 'name'));
  expect(closedPasses).toHaveLength(2);
  expect(closedPasses.every(call => call.targets.some(target => target.owner === 'media' && target.component === 'cover'))).toBe(true);
  expect(passes.every(call => call.targets.some(target => target.owner === 'media' && target.component === 'cover'))).toBe(true);
});
