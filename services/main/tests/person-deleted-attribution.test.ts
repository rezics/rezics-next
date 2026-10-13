import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { WorkReadSession, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type ReadRow } from '../src/modules/work/read-session.ts';
import { readAgent, readAgentCards } from '../src/modules/profiles/read.ts';
import { readCreditAttribution, readCreditAttributionCards, readDeletedPersonAttributions,
  type DeletedPersonAttributionProof } from '../src/modules/profiles/attribution.ts';
import { readNativeCredits } from '../src/modules/profiles/credits.ts';
import { namedDiscoveryCredits } from '../src/modules/discovery/credits.ts';
import { discoveryCredit, namedAuthorCredit, type ProjectedCredit } from '../src/modules/discovery/contract.ts';
import { searchPageAuthors } from '../src/modules/search/result-cards.ts';
import { resourceWorkCards } from '../src/modules/query/work-cards.ts';
import { feedWorkPresentations } from '../src/modules/feed/presentation.ts';
import { RV } from '../src/modules/work/activate.ts';
import type { FeedReadFrame } from '../src/modules/feed/frame.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const work = id(1), deleted = id(2), live = id(3), privateAgent = id(4), missing = id(5);
const term = (value: string) => ({ value, type: 'literal' });
const proof: DeletedPersonAttributionProof = { accountErasureId: id(8), erasureId: id(9), erasureEpoch: '12' };
const neutral = { identityStatus: 'deleted', displayName: 'Deleted author', handle: null } as const;
const credit = (agent: string, n = 10): ProjectedCredit => ({ id: id(n), role: 'author',
  participantKind: 'agent', provider: null, key: null, ordinal: null, agent, displayName: null, handle: null });

function fixture(options: { tombstone?: boolean; localBasis?: boolean } = {}) {
  const queries: string[] = [];
  const proofs = new Map<string, DeletedPersonAttributionProof>(options.tombstone === false ? [] : [[deleted, proof]]);
  const liveRow = { agent: term(live), displayName: term('Continuing author'),
    agentKind: term(`${RV}PersonAgent`), agentHead: term(id(20)) };
  const deps = {
    environment: { fuseki: { commandHealth: async () => ({ moduleVersion: 'fixture', instanceId: 'fixture', publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
    profiles: Object.fromEntries(Object.entries(profileRegistry).map(([key, profile]) => [key, profile.sha256])) }), query: async () => ({ results: { bindings: [] } }) } },
    profiles: {
      agentFence: async (agent: string) => agent === live ? 'active:1' : null,
      agentFences: async (agents: readonly string[]) => new Map(agents.includes(live) ? [[live, 'active:1']] : []),
      visibility: { read: async () => ({ visibility: 'public', version: '1' }) },
      listing: { read: async () => ({ listing: 'listed', version: '1' }) },
    },
    personPreferences: { profileVisible: async (agent: string) => agent === live,
      visibleNameOwners: async (agents: readonly string[]) => new Set(agents.filter(agent => agent === live)) },
    agentHandles: { current: async () => 'continuing-author', currents: async () => new Map([[live, 'continuing-author']]) },
    personAttributionTombstones: { read: async (agents: readonly string[]) => new Map([...proofs].filter(([agent]) => agents.includes(agent))) },
    discovery: { active: async () => ({ generation_id: 'credits:1', stale: false }),
      resourceCardPayloads: async () => new Map([['credits:1', new Map([[work, { primaryCredits: [credit(deleted)], rating: null }]])]]) },
  } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.invalid/v1/works'),
    { localBasis: options.localBasis }, { dataEpoch: 'epoch:1', sequence: '42' });
  session.query = async (body: string): Promise<ReadRow[]> => {
    queries.push(body);
    if (body.includes('SELECT ?head ?main ?mainHead')) return [{ head: term(id(21)), main: term(id(22)),
      mainHead: term(id(23)), public: term('true') }];
    if (body.includes('SELECT * WHERE')) return [
      { part: term('pointer'), work: term(work) },
      { part: term('credit'), work: term(work), id: term(id(10)), revision: term(id(30)), agent: term(deleted) },
    ];
    if (body.includes('NativeAgentCredit')) return [{ work: term(work), id: term(id(10)), revision: term(id(30)),
      agent: term(deleted), role: term('author') }];
    if (body.includes('SELECT ?agent ?displayName')) return body.includes(live) ? [liveRow] : [];
    if (body.includes('SELECT ?displayName ?agentKind')) return [liveRow];
    if (body.includes('SELECT ?work ?head ?main ?selection')) return [{ work: term(work) }];
    return [];
  };
  session.summaries = async () => [{ reference: work, status: 'available', type: 'work', disclosure: 'public',
    name: { value: 'Surviving Work', language: 'en', direction: 'ltr', basis: 'original' },
    avatar: { kind: 'fallback', key: 'work' } }] as unknown as Awaited<ReturnType<WorkReadSession['summaries']>>;
  return { session, proofs, queries };
}

test('only a journal-bound Person tombstone supplies neutral credit identity; profiles and actors remain missing', async () => {
  const { session } = fixture();
  expect(await readCreditAttribution(session, deleted)).toEqual(neutral);
  await expect(readAgent(session, deleted)).rejects.toBeInstanceOf(WorkReadMissing);
  expect((await readAgentCards(session, [deleted])).size).toBe(0);
  for (const agent of [privateAgent, missing]) {
    await expect(readCreditAttribution(session, agent)).rejects.toBeInstanceOf(WorkReadMissing);
  }
  const identities = await readCreditAttributionCards(session, [deleted, live, privateAgent, missing]);
  expect(identities.get(deleted)).toEqual(neutral);
  expect(identities.get(live)).toMatchObject({ identityStatus: 'active', displayName: 'Continuing author',
    handle: 'continuing-author', address: { prefix: '/@', key: 'continuing-author' } });
  expect([...identities.keys()]).toEqual([live, deleted]);
  const without = fixture({ tombstone: false });
  await expect(readCreditAttribution(without.session, deleted)).rejects.toBeInstanceOf(WorkReadMissing);
  delete without.session.deps.personAttributionTombstones;
  expect((await readDeletedPersonAttributions(without.session, [deleted])).size).toBe(0);
});

test('native credit, discovery, search, resource and feed readers retain deleted attribution without navigation or avatar', async () => {
  const { session, queries } = fixture();
  const native = await readNativeCredits(session, work);
  expect(native.items).toEqual([{ id: id(10), role: 'author', agent: deleted, ...neutral }]);
  expect(queries.find(query => query.startsWith('SELECT ?id ?agent ?role'))).not.toContain('rdfs:label');
  const named = await namedDiscoveryCredits(session, [credit(deleted), credit(live, 11), credit(privateAgent, 12)]);
  expect(named.get(deleted)).toEqual(neutral);
  expect(named.has(privateAgent)).toBe(false);
  const cardCredit = namedAuthorCredit(credit(deleted), named.get(deleted)!);
  if (!cardCredit) throw new Error('Deleted author card is unavailable');
  expect(cardCredit).toMatchObject({ agent: deleted, ...neutral });
  expect(Value.Check(discoveryCredit, cardCredit)).toBe(true);
  const unavailable = new Set<string>();
  const search = await searchPageAuthors(session, [work], true, unavailable);
  expect(search.get(work)).toEqual([cardCredit]);
  expect(unavailable.size).toBe(0);
  const cards = await resourceWorkCards(session, [work]);
  expect(cards.get(work)?.primaryCredits).toEqual([cardCredit]);
  const feed = await feedWorkPresentations(session, [work]);
  expect(feed.items.get(work)?.authors).toEqual([cardCredit]);
  await feed.fence();
  const actorState = { fences: new Map<string, string>(), handles: new Map<string, string>() };
  const frame = { actorState, cardAccess: async () => ({ actorState, match: () => [] }) } as unknown as FeedReadFrame;
  const framed = await feedWorkPresentations(session, [work], { frame, sources: [] });
  expect(framed.actors?.has(deleted)).toBe(false);
  expect(framed.items.get(work)?.authors).toEqual([cardCredit]);
  await framed.fence();
  for (const surface of [native.items[0], cardCredit, ...search.get(work)!, ...cards.get(work)!.primaryCredits,
    ...feed.items.get(work)!.authors, ...framed.items.get(work)!.authors]) {
    expect(surface).not.toHaveProperty('address');
    expect(surface).not.toHaveProperty('avatar');
    expect(surface).not.toHaveProperty('avatarUrl');
    expect(surface).not.toHaveProperty('links');
    expect(surface).not.toHaveProperty('bio');
  }
});

test('stale, malformed and recovery-held attribution cannot become a deleted identity', async () => {
  const { session } = fixture();
  let reads = 0;
  session.deps.personAttributionTombstones = { read: async () => new Map([[deleted,
    { ...proof, erasureEpoch: String(12 + reads++) }]]) };
  await expect(readDeletedPersonAttributions(session, [deleted])).rejects.toBeInstanceOf(WorkReadMoved);
  for (const invalid of [{ ...proof, erasureEpoch: '0' }, { ...proof, accountErasureId: '' }]) {
    session.deps.personAttributionTombstones = { read: async () => new Map([[deleted, invalid]]) };
    await expect(readDeletedPersonAttributions(session, [deleted])).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
  session.deps.personAttributionTombstones = { read: async () => { throw new WorkReadUnavailable('Recovery held'); } };
  await expect(readCreditAttribution(session, deleted)).rejects.toThrow('Recovery held');
  const batch = await resourceWorkCards(session, [work]);
  expect(batch.get(work)?.primaryCredits).toEqual([]);
});

test('a local Work read fences its retained tombstone proof at delivery', async () => {
  const { session, proofs } = fixture({ localBasis: true });
  expect(await readCreditAttribution(session, deleted)).toEqual(neutral);
  proofs.set(deleted, { ...proof, erasureEpoch: '13' });
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('optional deleted attribution failure keeps healthy live credits on every preview adapter', async () => {
  const { session } = fixture();
  session.deps.personAttributionTombstones = { read: async () => { throw new WorkReadUnavailable('Recovery held'); } };
  session.deps.discovery!.resourceCardPayloads = async () => new Map([['credits:1',
    new Map([[work, { primaryCredits: [credit(deleted), credit(live, 11)], rating: null }]])]]) as never;
  const cards = await readCreditAttributionCards(session, [live, deleted], 'preview');
  expect([...cards.keys()]).toEqual([live]);
  expect(cards.get(live)).toMatchObject({ identityStatus: 'active', displayName: 'Continuing author' });
  const named = await namedDiscoveryCredits(session, [credit(deleted), credit(live, 11)], 20, true);
  expect([...named.keys()]).toEqual([live]);
  expect((await resourceWorkCards(session, [work])).get(work)?.primaryCredits)
    .toEqual([expect.objectContaining({ agent: live, identityStatus: 'active' })]);
  await expect(readCreditAttributionCards(session, [live, deleted])).rejects.toThrow('Recovery held');
});

for (const adapter of ['cards', 'discovery'] as const) {
  test(`optional ${adapter} attribution does not make tombstone recovery a required delivery fence`, async () => {
    const { session } = fixture({ localBasis: true });
    let reads = 0;
    session.deps.personAttributionTombstones = { read: async () => {
      if (++reads > 2) throw new WorkReadUnavailable('Recovery held');
      return new Map([[deleted, proof]]);
    } };
    const result = adapter === 'cards' ? await readCreditAttributionCards(session, [deleted], 'preview')
      : await namedDiscoveryCredits(session, [credit(deleted)], 20, true);
    expect(result.get(deleted)).toEqual(neutral);
    await session.fenceDependencies();
    expect(reads).toBe(2);
  });

  test(`${adapter} live name disclosure is rechecked after paused tombstone enrichment`, async () => {
    const { session } = fixture();
    let resume: () => void = () => {}, reached: () => void = () => {};
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const released = new Promise<void>(resolve => { resume = resolve; });
    let visible = true;
    session.deps.personPreferences!.visibleNameOwners = async agents => new Set(visible ? agents.filter(agent => agent === live) : []);
    session.deps.personAttributionTombstones = { read: async () => {
      reached();
      await released;
      return new Map([[deleted, proof]]);
    } };
    const read = adapter === 'cards' ? readCreditAttributionCards(session, [deleted, live], 'preview')
      : namedDiscoveryCredits(session, [credit(deleted), credit(live, 11)], 20, true);
    await paused;
    visible = false;
    resume();
    expect([...(await read).keys()]).toEqual([deleted]);
  });
}
