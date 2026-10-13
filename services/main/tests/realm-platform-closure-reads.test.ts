import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { ResourceSummary } from '../src/modules/media/summary.ts';
import { fallbackAvatar } from '../src/modules/media/summary.ts';
import { configureDisclosure, configureDisclosurePool, discloseInventory, DisclosureStore,
  DisclosureUnavailable, type DisclosureChannel, type DisclosureDecision, type DisclosureTarget }
  from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../src/modules/suitability/policy.ts';
import { RV, hash, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadSession, WorkReadMissing, WorkReadUnavailable, WorkReadInvalid, WorkReadMoved,
  decodeReadCursor, type ReadRow } from '../src/modules/work/read-session.ts';
import { readRealmBasis, readRealmHeader, readRealmLanding } from '../src/modules/realm-reads/read-realm.ts';
import { readRealmWorks } from '../src/modules/realm-reads/read-works.ts';
import { readRealmDecision, readRealmDecisions } from '../src/modules/realm-reads/public-decision-index.ts';
import { readRealmZone } from '../src/modules/realm-reads/read-zone.ts';
import { readRealmThreads, readRealmThread } from '../src/modules/realm-reply/thread-read.ts';
import { RealmReplyThreadStore } from '../src/modules/realm-reply/thread-store.ts';
import { RealmReplyContentStore, RealmReplyUnavailable, REALM_REPLY_EVIDENCE_COST,
  type CurrentPlacementEvidenceInput } from '../src/modules/realm-reply/content-store.ts';
import { RealmDirectoryIndex, type DirectoryRow } from '../src/modules/realm-directory/index.ts';
import { readRealmDirectory } from '../src/modules/realm-directory/read.ts';
import { discloseNotifications } from '../src/modules/disclosure/notifications.ts';
import type { NotificationSubjectReader, SubjectResolution } from '../src/modules/notification/dispatcher.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { queryPublicRealmPhrase, PublicRealmUnavailable } from '../src/modules/work/search-public.ts';
import { readRankings } from '../src/modules/rankings/read.ts';
import type { ReadRankingProjection } from '../src/modules/rankings/projection.ts';
import { readZoneWorks } from '../src/modules/zone-modules/read.ts';
import { visibleFeedSources } from '../src/modules/feed/read.ts';
import { contentSubjectReader } from '../src/modules/notification/subjects.ts';
import type { ContentCore, ExactReadResult } from '../../content/src/core.ts';

const native = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const realm = native(1), space = native(2), head = native(3), work = native(4), selection = native(5), reply = native(6), zone = native(7);
const position = { dataEpoch: 'closure-owner-epoch', sequence: '17' };
const binding = (value: string) => ({ type: 'uri', value });
const actors = ['anonymous', 'stranger', 'member', 'owner', 'manager', 'moderator', 'operator', 'case-party'] as const;
type Actor = typeof actors[number];

async function expectUnavailable(operation: Promise<unknown>) {
  const result: unknown = await operation.then(() => null, (error: unknown) => error);
  expect(result instanceof WorkReadUnavailable || result instanceof DisclosureUnavailable).toBe(true);
}

// These are bounded owner responses, not persisted fixture records. Integration
// tests create resources and decisions through the product APIs. Keeping Access
// as a separate reader here detects adapters that never ask it for a Realm fence.
class OwnerDisclosure extends DisclosureStore {
  readonly calls: { targets: readonly DisclosureTarget[]; channel: DisclosureChannel }[] = [];
  decision: (target: DisclosureTarget, channel: DisclosureChannel) => DisclosureDecision = () => 'visible';
  unavailable = false;
  constructor() { super({} as Pool); }
  override async read(targets: readonly DisclosureTarget[], _viewer: Viewer, channel: DisclosureChannel) {
    this.calls.push({ targets, channel });
    if (this.unavailable) throw new DisclosureUnavailable('Disclosure owner is unavailable');
    return targets.map(target => this.decision(target, channel));
  }
}

function summary(id: string): ResourceSummary {
  return { reference: id, status: 'available', disclosure: 'public', type: 'realm',
    name: { value: `Community ${id.slice(-12)}`, language: 'en', direction: 'ltr', basis: 'requested' },
    avatar: fallbackAvatar('realm', id) } as ResourceSummary;
}

function ownerSession(actor: Actor = 'anonymous', input: { private?: boolean; reader?: boolean } = {}) {
  const reader = new OwnerDisclosure();
  let closed = false, proof = 'current-member-proof';
  const calls = { profile: 0, content: 0, thread: 0, policy: 0, summary: 0 };
  let queryRows: (query: string) => ReadRow[] = () => [];
  const graph = { commandHealth: async () => ({ instanceId: '00000000-0000-4000-8000-0000000000aa',
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false, publicSearchDeltaAvailable: false }),
    query: async (query: string) => {
    let rows: ReadRow[];
    if (query.includes('SELECT ?space ?realmRevision')) {
      calls.policy++;
      rows = [{ space: binding(space), realmRevision: binding(head), disclosure: binding(`${RV}${input.private ? 'Private' : 'Public'}`),
        visibility: binding(input.private ? 'private' : 'public'), mode: binding('open'),
        listing: binding('listed'), history: binding('everything'), admission: binding(input.private ? 'request' : 'open') }];
    } else if (query.includes('SELECT ?revision ?payload ?model')) {
      calls.profile++;
      rows = [{}];
    } else if (query.includes('SELECT ?name WHERE')) {
      rows = [{ name: { type: 'literal', value: 'Request community', 'xml:lang': 'en' } }];
    } else if (query.includes('SELECT ?work ?head ?owningWork')) {
      rows = [realm, work, selection, reply, zone].filter(id => query.includes(`<${id}>`))
        .map(id => ({ work: binding(id), head: binding(head),
          ...(id === work ? { owningWork: binding(work), owningHead: binding(head) } : {}) }));
    } else rows = queryRows(query);
    return { results: { bindings: rows } };
  } };
  const environment = { fuseki: graph, lineage: { dataEpoch: position.dataEpoch, routingEpoch: 'routing' },
    objectDirectory: '.temp/realm-platform-closure-owner' } as WorkActivationEnvironment;
  if (input.reader !== false) configureDisclosure(environment, reader);
  reader.decision = target => closed && target.owner === 'graph' && target.resource === realm ? 'hidden' : 'visible';
  const deps = { environment, access: { assertRecoveryOpen: async () => undefined, activePrincipalId: async () => native(20), realmReadProof: async () => proof || null },
    governance: { rules: { publishedRealmRules: async () => [],
      realmHeaderRules: async () => ({ rules: [], heads: new Map() }) } },
    content: { readExactBatch: async () => { calls.content++; return []; } },
    realmReplyThreads: { assertThreadProjection: async () => { calls.thread++; },
      focusBasis: async () => { calls.thread++; return null; },
      rankingRevision: async () => '1', rankedPage: async () => { calls.thread++; return { rows: [], revision: '1' }; },
      admitted: async () => new Map(), counts: async () => ({ counts: new Map(), complete: true }),
      votes: async () => new Map() },
  } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.test/v1/realms'),
    actor === 'anonymous' ? { limit: 2 } : { limit: 2, actingSubject: native(20 + actors.indexOf(actor)) }, position);
  if (actor !== 'anonymous') session.principal = { issuer: 'account.test', subject: actor } as never;
  session.summaries = async ids => { calls.summary++; return ids.map(summary); };
  return { session, reader, calls, close: () => { closed = true; }, restore: () => { closed = false; },
    revoke: () => { proof = ''; }, rows: (read: typeof queryRows) => { queryRows = read; } };
}

function workHydrationOwner() {
  const owner = ownerSession();
  let hydrate = () => {};
  const workSummary = { ...summary(work), type: 'work', avatar: fallbackAvatar('work', work) } as ResourceSummary;
  const commonRows = (query: string): ReadRow[] => {
    if (query.includes('SELECT ?work ?head WHERE')) return [{ work: binding(work) }];
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) return [{
      epoch: binding(position.dataEpoch), sequence: binding(position.sequence), r: binding(work),
      type: binding('work'), work: binding(work), head: binding(head), public: binding('true'),
      label: { type: 'literal', value: 'Independent Work', 'xml:lang': 'en' },
    }];
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) return [{
      epoch: binding(position.dataEpoch), sequence: binding(position.sequence), r: binding(work),
      revision: binding(head), type: binding('https://schema.org/CreativeWork'),
    }];
    return [];
  };
  owner.session.summaries = async ids => {
    owner.calls.summary++;
    if (ids.includes(work)) hydrate();
    return ids.map(id => id === work ? workSummary : summary(id));
  };
  return { ...owner, commonRows, onHydration: (read: typeof hydrate) => { hydrate = read; } };
}

const selectedWorkRow = { work: binding(work), head: binding(head), main: binding(native(8)),
  selection: binding(selection), contribution: binding(native(9)), language: binding('en') };

for (const actor of ['anonymous', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
  test(`closed-direct-deliveries-${actor}: current identity and authority cannot deliver Realm metadata or selections`, async () => {
    const owner = ownerSession(actor);
    owner.rows(query => query.includes('SELECT DISTINCT ?zone ?official')
      ? [{ zone: binding(zone), zoneSpace: binding(native(30)) }]
      : query.includes('SELECT DISTINCT ?id ?kind') ? [{ id: binding(selection), kind: binding('adoption'),
        work: binding(work), main: binding(native(8)), subject: binding(native(9)),
        revisionEpoch: binding(position.dataEpoch), sequence: binding('12'), epochOrder: binding('0') }] : []);
    const publication = async () => ({ zone, realm, space: native(30), disclosure: 'public', official: null,
      listing: 'listed', revision: head, presentation: {}, discovery: {} }) as never;
    const reads = [() => readRealmHeader(owner.session, realm), () => readRealmWorks(owner.session, realm),
      () => readRealmDecisions(owner.session, realm), () => readRealmDecision(owner.session, realm, selection),
      () => readRealmZone(owner.session, realm, publication)];
    for (const read of reads) await read();
    const hydrated = { ...owner.calls };
    owner.close();
    for (const read of reads) await expect(read()).rejects.toBeInstanceOf(WorkReadMissing);
    expect(owner.calls.profile).toBe(hydrated.profile);
    expect(owner.calls.summary).toBe(hydrated.summary);
    expect(owner.calls.content).toBe(hydrated.content);
    owner.restore();
    for (const read of reads) await read();
  });

  test(`closed-private-teaser-${actor}: request admission preserves its live teaser without bypassing closure`, async () => {
    const owner = ownerSession(actor, { private: true });
    owner.revoke();
    expect((await readRealmLanding(owner.session, realm)).profile).toBe('realm-join-page-v1');
    const profiles = owner.calls.profile;
    owner.close();
    await expect(readRealmLanding(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
    expect(owner.calls.profile).toBe(profiles);
    owner.restore();
    expect((await readRealmLanding(owner.session, realm)).profile).toBe('realm-join-page-v1');
  });
}

test('closure-during-private-teaser-hydration: published request rules cannot deliver after Realm closure', async () => {
  const owner = ownerSession('anonymous', { private: true });
  owner.session.deps.governance!.rules!.publishedRealmRules = async () => { owner.close(); return []; };
  await expect(readRealmLanding(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
});

test('closure-during-decision-index-hydration: a populated public decision page is discarded at delivery', async () => {
  const owner = ownerSession();
  let hydrate = () => {};
  owner.rows(query => {
    if (!query.includes('SELECT DISTINCT ?id ?kind')) return [];
    hydrate();
    return [{ id: binding(selection), kind: binding('adoption'), work: binding(work), main: binding(native(8)),
      subject: binding(native(9)), revisionEpoch: binding(position.dataEpoch), sequence: binding('12'), epochOrder: binding('0') }];
  });
  expect((await readRealmDecisions(owner.session, realm)).items.map(item => item.id)).toEqual([selection]);
  hydrate = owner.close;
  await expect(readRealmDecisions(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
});

for (const mismatch of [{ zone: native(31) }, { realm: native(31) }, { space: native(31) }, { official: 'other' }]) {
  test(`realm-zone-publication-pairing-${Object.keys(mismatch)[0]}: independent Spaces retain exact published identity checks`, async () => {
    const owner = ownerSession();
    owner.rows(query => query.includes('SELECT DISTINCT ?zone ?official')
      ? [{ zone: binding(zone), zoneSpace: binding(native(30)) }] : []);
    const publication = async () => ({ zone, realm, space: native(30), disclosure: 'public', official: null,
      listing: 'listed', revision: head, presentation: {}, discovery: {}, ...mismatch }) as never;
    await expect(readRealmZone(owner.session, realm, publication)).rejects.toBeInstanceOf(WorkReadUnavailable);
  });
}

test('closure-during-works-hydration: a populated Realm collection discards hydrated Works', async () => {
  const owner = workHydrationOwner();
  owner.rows(query => query.includes('SELECT DISTINCT ?work ?head ?main ?selection')
    ? [selectedWorkRow] : owner.commonRows(query));
  expect((await readRealmWorks(owner.session, realm)).items.map(item => item.id)).toEqual([work]);
  owner.onHydration(owner.close);
  await expect(readRealmWorks(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
});

test('closure-during-selection-hydration: an exact adopted selection is discarded after its owner row closes the Realm', async () => {
  const owner = ownerSession();
  let hydrate = () => {};
  owner.rows(query => {
    if (!query.includes('SELECT DISTINCT ?id ?kind')) return [];
    hydrate();
    return [{ id: binding(selection), kind: binding('adoption'), work: binding(work), main: binding(native(8)),
      subject: binding(native(9)), revisionEpoch: binding(position.dataEpoch), sequence: binding('12') }];
  });
  expect((await readRealmDecision(owner.session, realm, selection)).id).toBe(selection);
  hydrate = owner.close;
  await expect(readRealmDecision(owner.session, realm, selection)).rejects.toBeInstanceOf(WorkReadMissing);
});

test('closure-during-zone-entry-hydration: a fetched Zone publication cannot deliver its closed Realm entry', async () => {
  const owner = ownerSession();
  owner.rows(query => query.includes('SELECT DISTINCT ?zone ?official') ? [{ zone: binding(zone), zoneSpace: binding(native(30)) }] : []);
  let hydrate = () => {};
  const publication = async () => {
    hydrate();
    return { zone, realm, space: native(30), disclosure: 'public', official: null, listing: 'listed',
      revision: head, presentation: {}, discovery: {} } as never;
  };
  expect((await readRealmZone(owner.session, realm, publication)).zone).toBe(zone);
  hydrate = owner.close;
  await expect(readRealmZone(owner.session, realm, publication)).rejects.toBeInstanceOf(WorkReadMissing);
});

test('closure-during-zone-module-hydration: the mounted adoption shelf discards its hydrated cards', async () => {
  const owner = workHydrationOwner();
  owner.rows(query => query.includes('SELECT DISTINCT ?work ?head ?main ?evidence')
    ? [{ ...selectedWorkRow, evidence: binding(selection), revisionEpoch: binding(position.dataEpoch),
      sequence: binding('12'), epochOrder: binding('0') }] : owner.commonRows(query));
  expect((await readZoneWorks(owner.session, realm, 'new-adoptions')).items.map(item => item.id)).toEqual([work]);
  owner.onHydration(owner.close);
  await expect(readZoneWorks(owner.session, realm, 'new-adoptions')).rejects.toBeInstanceOf(WorkReadMissing);
});

function replyHydrationOwner() {
  const owner = workHydrationOwner();
  const revisionId = native(10).slice(-36), reviewDecisionId = native(11).slice(-36), placement = native(12);
  const node = { reply, parent: null, rootTarget: work, thread: reply };
  const placed = { id: binding(placement), reply: binding(reply), work: binding(work), author: binding(native(20)),
    revision: binding(`urn:rezics:content:revision:${revisionId}`),
    review: binding(`urn:rezics:realm-review:${reviewDecisionId}`), preparation: binding('closure-prepare'),
    rootRevision: binding(head), revisionEpoch: binding(position.dataEpoch), sequence: binding('12'), epochOrder: binding('0') };
  let hydrate = () => {};
  const body = { title: 'Community discussion', body: 'Community discussion\n\nA placed reply' };
  const serializedJson = JSON.stringify(body);
  const exact: ExactReadResult = { status: 'available', revisionId,
    reference: { owner: 'content', resourceId: reply, variantId: 'urn:rezics:variant:closure-reply', revisionId,
      format: 'rezics-content-json-v1', model: 'https://rezics.com/definition/realm-reply-v1',
      byteDigest: hash(serializedJson), byteLength: Buffer.byteLength(serializedJson),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', sourceRevision: null, predecessor: null,
      provenance: { kind: 'admitted-original-contribution-v1', author: native(20) } },
    serializedJson, body };
  owner.session.deps.content = { readExactBatch: async () => { owner.calls.content++; hydrate(); return [exact]; } } as unknown as ContentCore;
  owner.session.deps.profiles = { agentFences: async () => new Map() } as never;
  owner.session.deps.realmReplyThreads = { ...owner.session.deps.realmReplyThreads,
    focusBasis: async () => ({ thread: reply, active: true }),
    siblingOrderRevisions: async (_epoch: string, _realm: string, parents: readonly string[]) => new Map(parents.map(parent => [parent, '1'])), siblingPage: async () => [],
    identities: async () => [node], ancestors: async () => [],
    admitted: async () => new Map([[reply, { revisionId, reviewDecisionId }]]),
    rankedPage: async () => ({ rows: [{ reply, placement, rank_key: 1, time_key: '1' }], revision: '1' }),
  } as unknown as RealmReplyThreadStore;
  owner.rows(query => query.includes('SELECT DISTINCT ?id ?reply ?work ?author')
    || query.includes('SELECT ?id ?reply ?work ?author') ? [placed] : owner.commonRows(query));
  return { ...owner, revisionId, reviewDecisionId, placement, exact,
    onContentHydration: (read: typeof hydrate) => { hydrate = read; } };
}

test('hydration-fixtures-deliver-current-owner-data: closure races start from actual populated Work, module and placed Content reads', async () => {
  const works = workHydrationOwner();
  works.rows(query => query.includes('SELECT DISTINCT ?work ?head ?main ?selection')
    ? [selectedWorkRow] : works.commonRows(query));
  expect((await readRealmWorks(works.session, realm)).items.map(item => item.id)).toEqual([work]);
  const module = workHydrationOwner();
  module.rows(query => query.includes('SELECT DISTINCT ?work ?head ?main ?evidence')
    ? [{ ...selectedWorkRow, evidence: binding(selection), revisionEpoch: binding(position.dataEpoch),
      sequence: binding('12'), epochOrder: binding('0') }] : module.commonRows(query));
  expect((await readZoneWorks(module.session, realm, 'new-adoptions')).items.map(item => item.id)).toEqual([work]);
  const threads = replyHydrationOwner();
  expect((await readRealmThreads(threads.session, realm, { sort: 'top' })).items.map(item => item.reply)).toEqual([reply]);
  expect((await readRealmThread(threads.session, realm, reply, 'new')).items.map(item => item.reply)).toEqual([reply]);
  expect(threads.calls.content).toBeGreaterThan(0);
  const ranking = workHydrationOwner();
  ranking.rows(query => query.includes('SELECT DISTINCT ?work ?main ?head')
    ? [selectedWorkRow] : ranking.commonRows(query));
  const checkpoint = { generation: 'one', contentEpoch: 'content', contentSequence: '1',
    graphEpoch: position.dataEpoch, reviewPosition: '1' };
  const projection = { capture: async () => ({ checkpoint,
    rows: [{ work, score: '17', growth: '3' }], revision: '1' }),
    fence: async () => true } as unknown as ReadRankingProjection;
  for (const order of ['score', 'growth'] as const) {
    expect((await readRankings(ranking.session, projection,
      { realm, metric: 'reads', interval: 'week', order })).items.map(item => item.id)).toEqual([work]);
  }
});

for (const surface of ['threads', 'reply'] as const) {
  // thread-read bodies and final delivery lack the current placement Realm disclosure adapter.
  test.failing(`closure-during-${surface}-content-hydration: hydrated placed Content is discarded when its Realm closes`, async () => {
    const owner = replyHydrationOwner();
    const read = () => surface === 'threads' ? readRealmThreads(owner.session, realm, { sort: 'top' })
      : readRealmThread(owner.session, realm, reply, 'new');
    expect((await read()).items.map(item => item.reply)).toEqual([reply]);
    const before = owner.calls.content;
    owner.onContentHydration(owner.close);
    const result = read();
    // Assert the closure hook actually ran before checking the delivery refusal.
    await result.then(() => {}, () => {});
    expect(owner.calls.content).toBeGreaterThan(before);
    await expect(result).rejects.toBeInstanceOf(WorkReadMissing);
  });
}

for (const actor of actors) {
  test(`closed-home-${actor}: ordinary Realm basis stays absent with current identity and membership`, async () => {
    const owner = ownerSession(actor, { private: actor !== 'anonymous' });
    expect((await readRealmBasis(owner.session, realm)).id).toBe(realm);
    owner.close();
    await expect(readRealmBasis(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
    expect(owner.calls.profile).toBe(0);
    expect(owner.calls.content).toBe(0);
  });
}

test('restored-home-member: restoration restores current private policy and does not restore revoked membership', async () => {
  const owner = ownerSession('member', { private: true });
  owner.close();
  await expect(readRealmBasis(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
  owner.restore();
  expect((await readRealmBasis(owner.session, realm)).visibility).toBe('private');
  owner.revoke();
  await expect(readRealmBasis(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
});

test('closure-private-landing-no-exception: request admission cannot expose a closed Realm join teaser', async () => {
  const owner = ownerSession('anonymous', { private: true });
  expect((await readRealmLanding(owner.session, realm)).profile).toBe('realm-join-page-v1');
  owner.close();
  await expect(readRealmLanding(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
});

test('closure-delivery-race: a closure confirmed after summary hydration discards the Realm header', async () => {
  const owner = ownerSession('manager');
  owner.session.summaries = async ids => { owner.close(); return ids.map(summary); };
  await expect(readRealmHeader(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
});

test('closure-owner-unavailable-replay: missing or unavailable disclosure never grants a public Realm basis', async () => {
  const missing = ownerSession('anonymous', { reader: false });
  await expectUnavailable(readRealmBasis(missing.session, realm));
  const owner = ownerSession();
  owner.reader.unavailable = true;
  await expectUnavailable(readRealmBasis(owner.session, realm));
  owner.reader.unavailable = false;
  owner.close();
  await expect(readRealmBasis(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
  owner.restore();
  expect((await readRealmBasis(owner.session, realm)).id).toBe(realm);
});

test('narrow-realm-restriction: title and search restrictions do not imply whole-record closure', async () => {
  const owner = ownerSession();
  owner.reader.decision = (target, channel) => target.resource === realm
    && (target.component === 'title' || channel === 'search') ? 'hidden' : 'visible';
  expect((await readRealmBasis(owner.session, realm)).id).toBe(realm);
});

test('closed-works-anonymous: the Realm collection is missing before summary hydration even when empty', async () => {
  const owner = ownerSession();
  owner.close();
  await expect(readRealmWorks(owner.session, realm)).rejects.toBeInstanceOf(WorkReadMissing);
  expect(owner.calls.summary).toBe(0);
});

test('closed-selection-member: an exact publication selection cannot bypass the containing Realm', async () => {
  const owner = ownerSession('member');
  owner.rows(query => query.includes('SELECT DISTINCT ?id ?kind') ? [{ id: binding(selection), kind: binding('adoption'),
    work: binding(work), main: binding(native(8)), subject: binding(native(9)), revisionEpoch: binding(position.dataEpoch),
    sequence: binding('12') }] : []);
  expect((await readRealmDecision(owner.session, realm, selection)).id).toBe(selection);
  owner.close();
  await expect(readRealmDecision(owner.session, realm, selection)).rejects.toBeInstanceOf(WorkReadMissing);
});

for (const surface of ['threads', 'reply'] as const) {
  test(`closed-${surface}-manager: closure precedes Content and ranking owner hydration`, async () => {
    const owner = ownerSession('manager');
    owner.close();
    const read = surface === 'threads' ? readRealmThreads(owner.session, realm, { sort: 'top' })
      : readRealmThread(owner.session, realm, reply, 'new');
    await expect(read).rejects.toBeInstanceOf(WorkReadMissing);
    expect(owner.calls.thread).toBe(0);
    expect(owner.calls.content).toBe(0);
  });
}

test('closed-zone-discussion-entry: the Realm-owned Zone entry is missing before Zone presentation hydration', async () => {
  const owner = ownerSession();
  owner.rows(query => query.includes('SELECT DISTINCT ?zone ?official') ? [{ zone: binding(zone), zoneSpace: binding(native(30)) }] : []);
  let publications = 0;
  const publication = async () => { publications++; return { zone, realm, space: native(30), disclosure: 'public', official: null,
    listing: 'listed', revision: head, presentation: {}, discovery: {} } as never; };
  expect((await readRealmZone(owner.session, realm, publication)).zone).toBe(zone);
  publications = 0;
  owner.close();
  await expect(readRealmZone(owner.session, realm, publication)).rejects.toBeInstanceOf(WorkReadMissing);
  expect(publications).toBe(0);
});

test('independent-publication-not-descendant: Realm context alone is not a parent and does not replace the Work fence', async () => {
  const owner = ownerSession();
  owner.close();
  const target: DisclosureTarget = { owner: 'content', resource: reply, component: 'body', revision: native(10),
    context: realm, work, workRevision: head };
  expect(await discloseInventory(owner.session.deps.environment, [target], ANONYMOUS_VIEWER, 'read')).toEqual(['visible']);
  owner.reader.decision = item => item.work === work ? 'hidden' : 'visible';
  expect(await discloseInventory(owner.session.deps.environment, [target], ANONYMOUS_VIEWER, 'read')).toEqual(['hidden']);
  expect(owner.reader.calls.at(-1)!.targets[0]!.work).toBe(work);
  expect(owner.reader.calls.at(-1)!.targets[0]!.workRevision).toBe(head);
});

function countStore(reader = true) {
  const owner = ownerSession();
  const content = { query: async () => ({ rows: [{ thread: reply, id: native(11), parent_reply: reply,
    root_target: work, visible: true, truncated: false }] }) } as unknown as Pool;
  const access = {} as Pool;
  if (reader) { configureDisclosurePool(access, owner.reader); configureDisclosure(owner.session.deps.environment, owner.reader); }
  return { ...owner, store: new RealmReplyThreadStore(content, access) };
}

test('reply-count-work-fence: an independent Work restriction remains enforced in Realm reply counts', async () => {
  const owner = countStore();
  expect((await owner.store.counts(realm, [reply])).counts.get(reply)).toBe(1);
  owner.reader.decision = target => target.work === work ? 'hidden' : 'visible';
  expect((await owner.store.counts(realm, [reply])).counts.get(reply)).toBe(0);
  expect(owner.reader.calls.at(-1)!.targets[0]!.work).toBe(work);
});

// Fail-closed disclosure composition for reply counts is missing.
test.failing('reply-count-missing-reader: an uncomposed count adapter with approved content returns unavailable', async () => {
  const owner = countStore(false);
  await expectUnavailable(owner.store.counts(realm, [reply]));
});

function directoryOwner(ids: string[]) {
  const owner = ownerSession();
  const records: DirectoryRow[] = ids.map((id, index) => ({ realm: id, space: native(1000 + index), profile: null,
    rank: String(index), count_value: '0', count_revision: '1' }));
  const query = async (sql: string, values: unknown[] = []) => {
    let rows: object[] = [];
    if (sql.includes('FROM access.recovery_fence')) rows = [{}];
    else if (sql.includes('FROM access.realm_directory_position')) rows = [{ data_epoch: position.dataEpoch, sequence: position.sequence, generation: 1 }];
    else if (sql.includes('FROM access.realm_count_position')) rows = [{ revision: '1' }];
    else if (sql.includes('FROM access.realm_directory d')) rows = records
      .filter(row => values[0] === null || Number(row.rank) > Number(values[0])
        || row.rank === values[0] && row.realm > String(values[1])).slice(0, Number(values[3]));
    return { rows, rowCount: rows.length };
  };
  const realmDirectory = new RealmDirectoryIndex({ query,
    connect: async () => ({ query, release() {} }) } as unknown as Pool);
  const session = new WorkReadSession({ ...owner.session.deps,
    access: { ...owner.session.deps.access, realmDirectory } }, owner.session.request,
  owner.session.options, owner.session.position);
  session.summaries = owner.session.summaries;
  owner.rows(sparql => sparql.includes('SELECT ?realm ?space ?head ?mode') ? records.filter(row => sparql.includes(`<${row.realm}>`))
    .map(row => ({ realm: binding(row.realm), space: binding(row.space), head: binding(head), mode: binding('open') })) : []);
  return { ...owner, session };
}

test('closed-directory-before-drain: hidden indexed rows are omitted and live rows remain traversable', async () => {
  const hidden = Array.from({ length: 35 }, (_, index) => native(2000 + index));
  const visible = [native(3001), native(3002), native(3003)];
  const owner = directoryOwner([...hidden, ...visible]);
  owner.session.summaries = async ids => ids.map(id => hidden.includes(id)
    ? { reference: id, status: 'unavailable' } as ResourceSummary : summary(id));
  owner.reader.decision = target => hidden.includes(target.resource) ? 'hidden' : 'visible';
  const traversed: string[] = [];
  const cursors = new Set<string>();
  // A source budget may return a sparse or empty page with a continuation.
  // Traversal must still advance across every hidden source row and terminate.
  const maximumPages = hidden.length + visible.length + 1;
  let finished = false;
  for (let pages = 0; pages < maximumPages; pages++) {
    const page = await readRealmDirectory(owner.session, { sort: 'members' });
    const ids = page.items.map(item => item.id);
    expect(ids.length).toBeLessThanOrEqual(owner.session.options.limit!);
    for (const id of ids) expect(visible).toContain(id);
    traversed.push(...ids);
    if (!page.nextCursor) { finished = true; break; }
    expect(cursors.has(page.nextCursor)).toBe(false);
    cursors.add(page.nextCursor);
    const bytes = Buffer.from(page.nextCursor, 'base64url').toString('utf8');
    for (const id of [...hidden, ...visible]) {
      expect(bytes).not.toContain(id);
      expect(bytes).not.toContain(id.slice(-36));
    }
    expect(bytes).not.toContain(position.dataEpoch);
    owner.session.options.cursor = page.nextCursor;
  }
  expect(finished).toBe(true);
  expect(traversed).toEqual(visible);
});

test('narrow-search-restriction: directory classifies search visibility even when the Realm summary is public', async () => {
  const owner = directoryOwner([realm, native(4001)]);
  owner.reader.decision = (target, channel) => target.resource === realm && channel === 'search' ? 'hidden' : 'visible';
  expect((await readRealmDirectory(owner.session, { sort: 'members' })).items.map(item => item.id)).toEqual([native(4001)]);
  expect((await readRealmBasis(owner.session, realm)).id).toBe(realm);
});

test('directory-final-fence: closure during profile hydration refuses the selected page', async () => {
  const owner = directoryOwner([realm, native(4001)]);
  owner.session.summaries = async ids => { owner.close(); return ids.map(summary); };
  await expect(readRealmDirectory(owner.session, { sort: 'members' })).rejects.toBeInstanceOf(WorkReadMoved);
});

test('directory-hidden-cut: restoring during hydration cannot revive an opening hidden candidate', async () => {
  const owner = directoryOwner([realm, native(4001)]);
  owner.close();
  owner.session.summaries = async ids => { owner.restore(); return ids.map(summary); };
  await expect(readRealmDirectory(owner.session, { sort: 'members' })).rejects.toBeInstanceOf(WorkReadMoved);
});

test('directory-disclosure-unavailable: failed opening and final owner reads return unavailable without a page', async () => {
  const owner = directoryOwner([realm]);
  owner.reader.unavailable = true;
  await expectUnavailable(readRealmDirectory(owner.session, { sort: 'members' }));
  owner.reader.unavailable = false;
  owner.session.summaries = async ids => { owner.reader.unavailable = true; return ids.map(summary); };
  await expectUnavailable(readRealmDirectory(owner.session, { sort: 'members' }));
});

test('directory-missing-reader: current indexed candidates need a composed disclosure owner', async () => {
  const owner = directoryOwner([realm]);
  configureDisclosure(owner.session.deps.environment, null);
  await expectUnavailable(readRealmDirectory(owner.session, { sort: 'members' }));
});

test('directory-incomplete-disclosure: a shortened owner result cannot produce an exact empty page', async () => {
  const owner = directoryOwner([realm]);
  owner.reader.read = async () => [];
  await expectUnavailable(readRealmDirectory(owner.session, { sort: 'members' }));
});

test('directory-current-identity: a projected Realm needs its current reciprocal Space and head', async () => {
  const owner = directoryOwner([realm]);
  owner.rows(query => query.includes('SELECT ?realm ?space ?head ?mode')
    ? [{ realm: binding(realm), space: binding(native(4001)), head: binding(head), mode: binding('open') }] : []);
  await expectUnavailable(readRealmDirectory(owner.session, { sort: 'members' }));
});

test('directory-moved-identity: a changed Realm head during hydration discards the page', async () => {
  const owner = directoryOwner([realm]);
  let currentHead = head;
  owner.rows(query => query.includes('SELECT ?realm ?space ?head ?mode')
    ? [{ realm: binding(realm), space: binding(native(1000)), head: binding(currentHead), mode: binding('open') }] : []);
  owner.session.summaries = async ids => { currentHead = native(4001); return ids.map(summary); };
  await expect(readRealmDirectory(owner.session, { sort: 'members' })).rejects.toBeInstanceOf(WorkReadMoved);
});

test('directory-continuation-opacity: native continuation encrypts identity, ranking and source position and binds the query', async () => {
  const owner = directoryOwner([realm, native(5001), native(5002)]);
  const page = await readRealmDirectory(owner.session, { sort: 'members' });
  const token = page.nextCursor!;
  expect(decodeReadCursor(token, ['realm-directory-v3', 'members', '', null, null], position)?.after).toBe(native(5001));
  const decodedBytes = Buffer.from(token, 'base64url').toString('utf8');
  expect(decodedBytes).not.toContain(native(5001));
  expect(decodedBytes).not.toContain(position.dataEpoch);
  expect(() => decodeReadCursor(token, ['realm-directory-v3', 'members', 'other', null, null], position)).toThrow(WorkReadInvalid);
});

for (const sort of ['best', 'top'] as const) {
  test(`closed-thread-rankings-${sort}: ordinary ranked Realm routes read as missing until restored`, async () => {
    const owner = ownerSession();
    expect((await readRealmThreads(owner.session, realm, { sort })).items).toEqual([]);
    owner.close();
    await expect(readRealmThreads(owner.session, realm, { sort })).rejects.toBeInstanceOf(WorkReadMissing);
    owner.restore();
    expect((await readRealmThreads(owner.session, realm, { sort })).items).toEqual([]);
  });
}

for (const order of ['score', 'growth'] as const) {
  test(`closed-read-rankings-${order}: a retained ranking projection cannot expose a closed Realm scope`, async () => {
    const owner = ownerSession();
    // The projected aggregate stays intact: this milestone only filters reads.
    const checkpoint = { generation: 'one', contentEpoch: 'content', contentSequence: '1',
      graphEpoch: position.dataEpoch, reviewPosition: '1' };
    const projection = { capture: async () => ({ checkpoint, rows: [], revision: '1' }),
      fence: async () => true } as unknown as ReadRankingProjection;
    const options = { realm, metric: 'reads' as const, interval: 'week' as const, order };
    expect((await readRankings(owner.session, projection, options)).items).toEqual([]);
    owner.close();
    await expect(readRankings(owner.session, projection, options)).rejects.toBeInstanceOf(WorkReadMissing);
    owner.restore();
    expect((await readRankings(owner.session, projection, options)).items).toEqual([]);
  });
}

for (const order of ['score', 'growth'] as const) {
  test(`closure-during-read-rankings-${order}-hydration: retained ranking rows cannot deliver after their Realm closes`, async () => {
    const owner = workHydrationOwner();
    owner.rows(query => query.includes('SELECT DISTINCT ?work ?main ?head')
      ? [selectedWorkRow] : owner.commonRows(query));
    const checkpoint = { generation: 'one', contentEpoch: 'content', contentSequence: '1',
      graphEpoch: position.dataEpoch, reviewPosition: '1' };
    const projection = { capture: async () => ({ checkpoint,
      rows: [{ work, score: '17', growth: '3' }], revision: '1' }),
      fence: async () => true } as unknown as ReadRankingProjection;
    const options = { realm, metric: 'reads' as const, interval: 'week' as const, order };
    expect((await readRankings(owner.session, projection, options)).items.map(item => item.id)).toEqual([work]);
    owner.onHydration(owner.close);
    await expect(readRankings(owner.session, projection, options)).rejects.toBeInstanceOf(WorkReadMissing);
  });
}

function notificationOwner() {
  const owner = ownerSession();
  const pool = {} as Pool;
  configureDisclosurePool(pool, owner.reader);
  type Input = Parameters<NotificationSubjectReader['resolve']>[0];
  const queued: { input: Input; result: SubjectResolution }[] = [
    { input: { principalId: native(20), owner: 'content', ref: reply, revision: native(10),
      disclosureBasis: 'realm-reply-v1', realm },
      result: { status: 'available', subject: { private: false,
        fields: { title: 'Community discussion', body: 'A placed reply', linkTarget: work, linkTitle: 'Independent Work' } } } },
    { input: { principalId: native(20), owner: 'graph', ref: work, revision: null,
      disclosureBasis: 'work-publication-v1', realm: null },
      result: { status: 'available', subject: { private: false,
        fields: { title: 'Independent publication', linkTarget: work } } } },
  ];
  return { ...owner, pool, queued };
}

for (const channel of ['inbox', 'count', 'digest', 'email', 'push'] as const) {
  // Owner-established Work and Realm ancestry at notification delivery is missing.
  test.failing(`closed-notifications-${channel}: queued Realm content is reclassified at delivery while independent subjects stay available`, async () => {
    const owner = notificationOwner();
    const original = owner.queued.map(subject => subject.result);
    expect(await discloseNotifications(owner.pool, owner.queued, channel)).toEqual(original);
    owner.close();
    expect(await discloseNotifications(owner.pool, owner.queued, channel)).toEqual([
      { status: 'undisclosed' }, original[1],
    ]);
    owner.restore();
    expect(await discloseNotifications(owner.pool, owner.queued, channel)).toEqual(original);
  });
}

test('restored-notifications-preserve-reply-fence: Realm restoration cannot release an independent reply restriction', async () => {
  const owner = notificationOwner();
  owner.close();
  owner.reader.decision = target => target.resource === reply ? 'hidden' : 'visible';
  owner.restore();
  expect(await discloseNotifications(owner.pool, owner.queued, 'inbox')).toEqual([
    { status: 'undisclosed' }, owner.queued[1]!.result,
  ]);
});

for (const channel of ['inbox', 'count', 'digest', 'email', 'push'] as const) {
  // discloseNotifications lacks the owner-established placement Realm adapter after exact subject hydration.
  test.failing(`closure-during-notifications-${channel}-hydration: a fetched reply subject cannot survive closure before delivery`, async () => {
    const owner = replyHydrationOwner();
    const notification = notificationOwner();
    configureDisclosurePool(notification.pool, owner.reader);
    const subject = contentSubjectReader(owner.session.deps.content!, async ids => new Set(ids));
    const input = { ...notification.queued[0]!.input, revision: owner.revisionId };
    const initial = await subject.resolve(input);
    expect(initial.status).toBe('available');
    expect(await discloseNotifications(notification.pool, [{ input, result: initial }, notification.queued[1]!], channel))
      .toEqual([initial, notification.queued[1]!.result]);
    owner.onContentHydration(owner.close);
    const hydrated = await subject.resolve(input);
    expect(hydrated.status).toBe('available');
    expect(await discloseNotifications(notification.pool, [{ input, result: hydrated }, notification.queued[1]!], channel))
      .toEqual([{ status: 'undisclosed' }, notification.queued[1]!.result]);
  });
}

function feedHydrationOwner() {
  const owner = replyHydrationOwner();
  const independent = native(13);
  let hydrate = () => {};
  owner.rows((query): ReadRow[] => {
    if (!query.includes('SELECT DISTINCT ?id ?sequence ?kind ?target')) return owner.commonRows(query);
    hydrate();
    return [
      { id: binding(owner.placement), sequence: binding('12'), kind: binding('discussion'), target: binding(reply),
        work: binding(work), actor: binding(native(20)), realm: binding(realm),
        reply: binding(reply), contentRevision: binding(`urn:rezics:content:revision:${owner.revisionId}`),
        review: binding(`urn:rezics:realm-review:${owner.reviewDecisionId}`) },
      { id: binding(independent), sequence: binding('13'), kind: binding('work'), target: binding(work),
        work: binding(work), actor: binding(native(20)) },
    ];
  });
  const sources = [{ id: owner.placement, kind: 'discussion' }, { id: independent, kind: 'work' }];
  return { ...owner, sources, independent, onSourceHydration: (read: typeof hydrate) => { hydrate = read; } };
}

test('feed-hydration-fixture-delivers-owner-sources: both Realm-backed and independent sources are delivered before closure', async () => {
  const owner = feedHydrationOwner();
  const sources = await visibleFeedSources(owner.session, owner.sources);
  expect(sources.map(source => source.id)).toEqual([owner.placement, owner.independent]);
  expect(sources[0]).toMatchObject({ realm, reply,
    contentRevision: `urn:rezics:content:revision:${owner.revisionId}` });
});

// feedSources lacks the owner-established placement Realm adapter after activity source hydration.
test.failing('closure-during-feed-source-hydration: a Realm-backed activity drops while an independent publication stays traversable', async () => {
  const owner = feedHydrationOwner();
  const { sources, independent } = owner;
  expect((await visibleFeedSources(owner.session, sources)).map(source => source.id)).toEqual([owner.placement, independent]);
  owner.onSourceHydration(owner.close);
  expect((await visibleFeedSources(owner.session, sources)).map(source => source.id)).toEqual([independent]);
});

function realmSearchOwner() {
  const owner = ownerSession();
  const generation = 'urn:rezics:search-generation:closure-owner';
  owner.rows(query => {
    if (query.includes('SELECT ?candidateCount ?epoch ?sequence ?indexGeneration')) return [{
      candidateCount: binding('1'), epoch: binding(position.dataEpoch), sequence: binding(position.sequence),
      indexGeneration: binding(generation), unit: binding(native(6001)), score: binding('1'),
      work: binding(work), main: binding(native(8)), contribution: binding(native(9)),
      revision: binding(`urn:rezics:content:revision:${native(10).slice(-36)}`), selection: binding(selection),
      language: binding('en'), reason: binding('realm-adoption'),
    }];
    if (query.includes('SELECT ?work ?head WHERE')) return [{ work: binding(work), head: binding(head) }];
    return [];
  });
  const env = owner.session.deps.environment;
  const read = () => searchGraphSnapshot.run({ clients: new Set([env.fuseki]), lineage: env.lineage,
    position: { ...position, generation, population: 1, serverInstanceId: '00000000-0000-4000-8000-0000000000aa',
      publicSearchWriteEpoch: '0' } }, () => queryPublicRealmPhrase(env,
  { phrase: 'Community discussion', language: 'en', context: { kind: 'realm-local', id: realm } }));
  return { ...owner, read };
}

// discloseSearchMatches lacks the current Realm occurrence adapter after index-row hydration.
test.failing('closure-during-search-hydration: a Realm occurrence hydrated before closure is absent at final selection', async () => {
  const owner = realmSearchOwner();
  expect((await owner.read()).results.map(row => row.selection)).toEqual([selection]);
  const graph = owner.session.deps.environment.fuseki;
  const query = graph.query.bind(graph);
  let hydrated = false;
  graph.query = async (...args: Parameters<typeof query>) => {
    const result = await query(...args);
    if (args[0].includes('SELECT ?work ?head WHERE')) { hydrated = true; owner.close(); }
    return result;
  };
  const result = await owner.read().catch((error: unknown) => error);
  expect(hydrated).toBe(true);
  if (!(result instanceof WorkReadMissing) && !(result instanceof PublicRealmUnavailable)) {
    expect(result).toMatchObject({ total: 0, results: [] });
  }
});

// Current Realm occurrence disclosure before search selection is missing.
test.failing('closed-realm-search: a live Realm-adopted search occurrence disappears despite retained index rows', async () => {
  const owner = realmSearchOwner();
  const initial = await owner.read();
  expect(initial.results.map(row => row.selection)).toEqual([selection]);
  owner.close();
  const closed = await owner.read().catch((error: unknown) => error);
  if (!(closed instanceof WorkReadMissing) && !(closed instanceof PublicRealmUnavailable)) {
    expect(closed).toMatchObject({ total: 0, results: [] });
  }
  owner.restore();
  expect((await owner.read()).results).toEqual(initial.results);
});

test('restored-realm-search: restoring the Realm keeps an independent Work fence and later owner release re-enables the occurrence', async () => {
  const owner = realmSearchOwner();
  const initial = await owner.read();
  expect(initial.total).toBe(1);
  owner.close();
  owner.reader.decision = target => target.resource === work || target.work === work ? 'hidden' : 'visible';
  owner.restore();
  expect((await owner.read()).results).toEqual([]);
  owner.reader.decision = () => 'visible';
  expect((await owner.read()).results).toEqual(initial.results);
});
function placementEvidenceOwner(size = 1) {
  const heads: CurrentPlacementEvidenceInput[] = Array.from({ length: size }, (_, index) => ({
    realm, reply: native(7000 + index), revisionId: native(8000 + index).slice(-36),
    reviewDecisionId: native(9000 + index).slice(-36), preparationId: `prepare:${index}`,
  }));
  const complete = heads.map((head, ordinal) => ({ ordinal, realm: head.realm, reply: head.reply,
    revision: head.revisionId, review: head.reviewDecisionId, preparation: head.preparationId,
    origin: ordinal % 2 === 0 ? realm : null, author: native(20), root: work, root_revision: native(30),
    variant: `urn:rezics:variant:${ordinal}`, revision_digest: 'a'.repeat(64),
    data_epoch: native(40).slice(-36), sequence: String(ordinal + 1),
  }));
  let rows: Record<string, unknown>[] = complete;
  const calls: { sql: string; requested: unknown[] }[] = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, requested: JSON.parse(values[0] as string) as unknown[] });
    return { rows, rowCount: rows.length };
  } } as unknown as Pool;
  return { heads, complete, calls, store: new RealmReplyContentStore(pool),
    rows: (next: Record<string, unknown>[]) => { rows = next; } };
}

test('placement-evidence-bounds: exact current approvals retain root and receipt position in one ordered 64-target owner read', async () => {
  const owner = placementEvidenceOwner(REALM_REPLY_EVIDENCE_COST.batch);
  const evidence = await owner.store.currentPlacementEvidence(owner.heads);
  expect(evidence).toHaveLength(64);
  expect(owner.calls).toHaveLength(1);
  expect(owner.calls[0]!.requested).toHaveLength(64);
  expect(evidence.map(item => item.reply)).toEqual(owner.heads.map(head => head.reply));
  expect(evidence[0]).toEqual({ ...owner.heads[0]!, originRealm: realm, author: native(20),
    variantId: 'urn:rezics:variant:0', revisionDigest: 'a'.repeat(64),
    rootTarget: work, rootRevision: native(30),
    ownerPosition: { owner: 'content', dataEpoch: native(40).slice(-36), sequence: '1' } });
  expect(evidence[1]!.originRealm).toBeNull();
  await expect(owner.store.currentPlacementEvidence([...owner.heads, owner.heads[0]!])).rejects.toBeInstanceOf(RealmReplyUnavailable);
  expect(owner.calls).toHaveLength(1);
  expect(await owner.store.currentPlacementEvidence([])).toEqual([]);
  expect(owner.calls).toHaveLength(1);
});

test('placement-evidence-invalid-selection: exact review and preparation are mandatory before any owner read', async () => {
  const owner = placementEvidenceOwner();
  for (const malformed of [{ reviewDecisionId: '' }, { preparationId: '' }, { preparationId: 'bad preparation' },
    { preparationId: 'x'.repeat(201) }, { revisionId: 'unknown' }, { realm: 'request-context' }]) {
    await expect(owner.store.currentPlacementEvidence([{ ...owner.heads[0]!, ...malformed }])).rejects.toBeInstanceOf(RealmReplyUnavailable);
  }
  expect(owner.calls).toHaveLength(0);
});

test('placement-evidence-incomplete: omitted or duplicated owner ordinals fail the whole batch', async () => {
  const owner = placementEvidenceOwner(2);
  for (const rows of [[owner.complete[0]!], [owner.complete[0]!, owner.complete[0]!],
    [owner.complete[1]!, owner.complete[0]!], [...owner.complete, owner.complete[1]!]]) {
    owner.rows(rows);
    await expect(owner.store.currentPlacementEvidence(owner.heads)).rejects.toBeInstanceOf(RealmReplyUnavailable);
  }
});

test('placement-evidence-moved-binding: another reply, Realm, revision, approval or preparation cannot authorize these targets', async () => {
  const owner = placementEvidenceOwner();
  for (const changed of [{ reply: native(9991) }, { realm: native(9992) }, { revision: native(9993).slice(-36) },
    { review: native(9994).slice(-36) }, { preparation: 'other-prepare' }, { origin: native(9995) },
    { root: 'invalid-root' }, { root_revision: 'invalid-pinned-root' }, { author: 'invalid-author' },
    { variant: '' }, { variant: 'x'.repeat(301) }, { revision_digest: 'invalid-digest' }]) {
    owner.rows([{ ...owner.complete[0]!, ...changed }]);
    await expect(owner.store.currentPlacementEvidence(owner.heads)).rejects.toBeInstanceOf(RealmReplyUnavailable);
  }
});

test('placement-evidence-unsettled-receipt: absent, corrupt or unassigned owner positions cannot supply source evidence', async () => {
  const owner = placementEvidenceOwner();
  for (const receipt of [{ data_epoch: null, sequence: null }, { data_epoch: 'unknown', sequence: '1' },
    { sequence: '0' }, { sequence: '-1' }, { sequence: '1.5' }]) {
    owner.rows([{ ...owner.complete[0]!, ...receipt }]);
    await expect(owner.store.currentPlacementEvidence(owner.heads)).rejects.toBeInstanceOf(RealmReplyUnavailable);
  }
});

test('placement-evidence-owner-recovery: current approval removal is unavailable and later exact owner recovery is read again', async () => {
  const owner = placementEvidenceOwner();
  const initial = await owner.store.currentPlacementEvidence(owner.heads);
  owner.rows([]);
  await expect(owner.store.currentPlacementEvidence(owner.heads)).rejects.toBeInstanceOf(RealmReplyUnavailable);
  owner.rows(owner.complete);
  expect(await owner.store.currentPlacementEvidence(owner.heads)).toEqual(initial);
  expect(owner.calls).toHaveLength(3);
  const unavailable = new RealmReplyContentStore({ query: async () => { throw new Error('owner disconnected'); } } as unknown as Pool);
  await expect(unavailable.currentPlacementEvidence(owner.heads)).rejects.toBeInstanceOf(RealmReplyUnavailable);
});

test('current-review-compatibility: ordinary approval callers retain optional review and preparation semantics', async () => {
  const owner = placementEvidenceOwner();
  owner.rows([{ ordinal: 0 }]);
  const { realm, reply, revisionId } = owner.heads[0]!;
  expect(await owner.store.currentReviews([{ realm, reply, revisionId }])).toEqual(new Set([0]));
  expect(owner.calls).toHaveLength(1);
});
