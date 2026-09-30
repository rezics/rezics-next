import { SeedApiError } from './api.ts';
import { grantCuratedCollectionSeed, grantHomeSeedAuthority, grantOfficialZoneSeed } from './operator.ts';
import { seedKey, zoneSites } from './plan.ts';
import { stableId, type ContributionReceipt, type PublicationReceipt, type SeedState, type Session, type WorkReceipt,
  afterCatchUp, refreshSeedTokens } from './state.ts';

// The Books Zone's own pages, made as its steward would: a guide document and a long Collection, each mounted in
// the Zone's navigation so `/r/books/guide` and `/r/books/picks` exist on a fresh seed. Every write is an API
// command with a stable key, and a mount that already resolves is left alone, so the step replays.

const short = (id: string) => id.slice(-36);
const DOCUMENT = 'https://schema.org/DigitalDocument';

interface Site { state: SeedState; steward: Session; zone: string; actor: string }

/** Whether the Zone already resolves this path, read as anyone may. */
async function mounted({ state, zone }: Site, segment: string): Promise<boolean> {
  try {
    await state.api.getPublic(`/v1/zones/${short(zone)}/routes?${new URLSearchParams({ path: `/${segment}` })}`);
    return true;
  } catch (error) {
    if (error instanceof SeedApiError && error.status === 404) return false;
    throw error;
  }
}

/** Mounts `target` at `segment`. The navigation's head moves with every mount, so a lost race reads it again. */
async function mount(site: Site, segment: string, target: string, position: 'first' | 'last') {
  const { state, steward, zone, actor } = site;
  if (await mounted(site, segment)) return;
  for (let attempt = 0; ; attempt++) {
    const current = await state.api.get<{ revision: string }>(
      `/v1/zones/${short(zone)}?actingSubject=${encodeURIComponent(actor)}&limit=1`, steward.token);
    try {
      await state.api.post(`/v1/zones/${short(zone)}/mounts`, { expectedHead: current.revision, target,
        routeSegment: segment, disclosure: 'public', position, actingSubject: actor }, steward.token,
      seedKey('zone-mount', `books:${segment}:${attempt}`));
      return;
    } catch (error) {
      if (!(error instanceof SeedApiError) || error.status !== 409) throw error;
      // The segment is already taken, by an earlier run whose read had not caught up.
      if (error.detail.includes('zone_route_conflict')) return;
      if (attempt >= 3) throw error;
    }
  }
}

/** The guide: a document Work whose published text is the page. */
async function guide(site: Site) {
  const { state, steward, actor } = site;
  const plan = zoneSites.books.guide;
  const work = await state.api.post<WorkReceipt>('/v1/works', { profile: 'metadata-only-v1', title: plan.title,
    semanticTypes: [DOCUMENT], language: plan.language, authoring: 'own-work', actingSubject: actor },
  steward.token, seedKey('zone-site-work', 'books:guide'));
  await grantHomeSeedAuthority({ ...state.operatorInput!, ownerAccountSubject: steward.accountId, actingSubject: actor },
    [{ action: 'work.read', scope: `work:read:${work.work}` }]);
  const contribution = await state.api.post<ContributionReceipt>('/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language: plan.language, body: plan.text, actingSubject: actor },
  steward.token, seedKey('zone-site-contribution', 'books:guide'));
  const published = await state.api.post<PublicationReceipt>('/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: contribution.contribution,
    expectedDraftHead: contribution.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor },
  steward.token, seedKey('zone-site-publication', 'books:guide'));
  await state.api.post('/v1/publication-selections', { profile: 'main-default-selection-v1',
    context: { kind: 'main-version-default', id: work.mainVersion }, work: work.work,
    contribution: contribution.contribution, publicationDecision: published.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor },
  steward.token, seedKey('zone-site-selection', 'books:guide'));
  await afterCatchUp(() => mount(site, plan.segment, work.work, 'first'));
}

/** The picks: a public Collection of the seed's public Works, more than one page of them. */
async function picks(site: Site) {
  const { state, steward, actor } = site;
  const plan = zoneSites.books.picks;
  const input = { ...state.operatorInput!, ownerAccountSubject: steward.accountId, actingSubject: actor };
  const members = [...new Set([...state.publicWorks.values()].map(item => item.work.work)
    .concat([...state.publicForRealm.keys()].flatMap(id => state.created.get(id)?.work ?? [])))].slice(0, plan.limit);
  const collection = `https://rezics.com/id/${stableId('zone-site:books:picks')}`;
  await grantCuratedCollectionSeed(input, collection);
  for (let at = 0; at < members.length; at += 9) {
    await grantHomeSeedAuthority(input, members.slice(at, at + 9).map(work =>
      ({ action: 'work.read' as const, scope: `work:read:${work}` })));
  }
  await state.api.post('/v1/collections', { collection, name: plan.name, disclosure: 'public', actingSubject: actor },
    steward.token, seedKey('zone-site-collection', 'books:picks'));
  const current = await state.api.get<{ structure: string; revision: string;
    occurrences: { role: string; target: string | null }[] }>(
    `/v1/collections/${short(collection)}?actingSubject=${encodeURIComponent(actor)}&limit=100`, steward.token);
  const held = new Set(current.occurrences.filter(item => item.role === 'member').map(item => item.target));
  const additions = members.filter(work => !held.has(work)).map(target => ({ op: 'insert', role: 'member',
    parent: current.structure, position: 'last', target, selection: { mode: 'follow-context' } }));
  let head = current.revision;
  // Main takes at most 16 operations in a change.
  for (let at = 0; at < additions.length; at += 16) {
    const changed = await state.api.post<{ revision: string }>(`/v1/collections/${short(collection)}/changes`, {
      expectedHead: head, actingSubject: actor, operations: additions.slice(at, at + 16) }, steward.token,
    seedKey('zone-site-members', `books:picks:${head.slice(-12)}`));
    head = changed.revision;
  }
  await afterCatchUp(() => mount(site, plan.segment, collection, 'last'));
}

/** The Books Zone's guide and picks, mounted through the API. */
export async function seedZoneSites(state: SeedState) {
  const realm = state.createdRealms.find(item => item.id === 'books');
  if (!realm || !state.operatorInput) {
    state.findings.add('Zone sites: the Books Realm or the local fixture operator are unavailable');
    return;
  }
  const zone = `https://rezics.com/id/${stableId('zone:books')}`;
  const site: Site = { state, steward: realm.steward, zone, actor: realm.steward.actingSubject };
  await refreshSeedTokens(state);
  await grantOfficialZoneSeed({ ...state.operatorInput, ownerAccountSubject: realm.steward.accountId,
    actingSubject: site.actor }, zone);
  await state.optional('Zone sites: Books guide', () => guide(site));
  await refreshSeedTokens(state);
  await state.optional('Zone sites: Books picks', () => picks(site));
}
