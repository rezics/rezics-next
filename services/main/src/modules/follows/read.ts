import type { Static } from 'typebox';
import { FOLLOWED_AUTHORS_COST, newestAuthorWorks, readExternalAuthorTarget } from '../author-page/follow.ts';
import { readAgent, readAgentCards, shelfWorks } from '../profiles/read.ts';
import { readAuthorNames } from '../source/author-name-read.ts';
import { resolveConcepts } from '../concept-page/read.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadLimit, WorkReadMissing, WorkReadMoved,
  publicWork, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { readResourceSummaries, type ResourceSummary } from '../media/summary.ts';
import { targetSummaryReader } from '../target/resolve.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { AUTHOR_FOLLOW_KINDS, externalAuthorKey, FOLLOWS_COST, type followedAuthorsPage, type followsPage,
  type followTarget, type FollowKind } from './contract.ts';
import { followMetadata, type FollowRow, type FollowsStore } from './store.ts';
import { followSpace } from './targets.ts';
import { SavedFilterMissing } from '../saved-filter/store.ts';
import { readNewSince } from '../feed/new-since.ts';
import { inOrder } from '../feed/settled.ts';

/** Must receive an anonymous session: a bearer never widens follow disclosure. */
export async function readFollowTarget(session: WorkReadSession, target: string, kind: FollowKind,
  summaries?: ReadonlyMap<string, ResourceSummary>, reader?: { principal: VerifiedPrincipal; agent: string }): Promise<Static<typeof followTarget>> {
  if (session.principal) throw new WorkReadUnavailable('Public follow reader required');
  if (kind === 'external-author') return readExternalAuthorTarget(session, target);
  if (kind === 'saved-view') {
    if (!reader || !session.deps.savedFilters) throw new WorkReadMissing('Saved view is unavailable');
    let view;
    try { view = await session.deps.savedFilters.read(reader.principal,reader.agent,target.slice('urn:rezics:saved-view:'.length)); }
    catch (error) { if (error instanceof SavedFilterMissing) throw new WorkReadMissing('Saved view is unavailable'); throw error; }
    const concept = view.concept ? await readFollowTarget(session,view.concept,'concept') : null;
    return { id: target, kind, name: view.name ? { value: view.name, language: 'und', direction: 'ltr', basis: 'fallback' }
      : concept!.name, icon: concept?.icon ?? { kind: 'fallback', policy: 'avatar-fallback-v1', key: target, resourceType: 'saved-view' },
    realm: null, href: `/?tab=${view.id}` };
  }
  if (kind === 'space') {
    const space = (await spaceFollowTargets(session,[target],reader)).get(target);
    if (!space) throw new WorkReadMissing('Space is unavailable');
    return space;
  }
  if (kind === 'agent') {
    const agent = await readAgent(session, target);
    return { id: target, kind, name: { value: agent.displayName, language: 'und', direction: 'ltr', basis: 'fallback' },
      icon: { kind: 'fallback', policy: 'avatar-fallback-v1', key: target, resourceType: 'agent' },
      realm: null, href: agent.links.profile };
  }
  let summaryId = target;
  let owner: string | null = null;
  if (kind === 'concept') {
    const concept = (await resolveConcepts(session, [target])).get(target);
    if (!concept) throw new WorkReadMissing('Follow target is unavailable');
    owner = concept.realm;
  }
  if (kind === 'work') {
    const visible = await session.query(`SELECT DISTINCT ?work WHERE { BIND(${iri(target)} AS ?work)
      ${publicWork('?work', '?main')} } LIMIT 2`, 1);
    if (!visible.length) throw new WorkReadMissing('Follow target is unavailable');
  }
  if (kind === 'realm') {
    const visible = await session.query(`SELECT ?realm WHERE { GRAPH ${iri(GRAPHS.current)} {
      BIND(${iri(target)} AS ?realm)
      ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
      FILTER NOT EXISTS { ?realm rv:protectionHead ?protection }
    } } LIMIT 2`, 1);
    if (!visible.length) throw new WorkReadMissing('Follow target is unavailable');
  }
  if (kind === 'zone') {
    const rows = await session.query(`SELECT ?realm WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(target)} a rv:Zone ; rv:space ?space ; rv:zoneState rv:Active ; rv:disclosure rv:Public ; rv:zoneHead ?head .
      ?space a rv:Space ; rv:zoneCapability ${iri(target)} ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
      FILTER NOT EXISTS { ${iri(target)} rv:disclosure rv:Private }
      FILTER NOT EXISTS { ${iri(target)} rv:protectionHead ?protection }
      FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
    } GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ZoneRevision ; rv:component ${iri(target)} .
      FILTER NOT EXISTS { ?head a rv:ErasedRevision } } } LIMIT 2`, 1);
    if (!rows[0]?.realm) throw new WorkReadMissing('Follow target is unavailable');
    summaryId = rows[0].realm.value;
  }
  const generic = !['work','realm','zone','concept'].includes(kind);
  const summary = summaries?.get(summaryId) ?? (generic
    ? (await readResourceSummaries(session.deps.environment,session.deps.media?.store,targetSummaryReader(session),
      { resources: [summaryId], context: DEFAULT_MEDIA_CONTEXT, language: session.options.language ?? null,
        includeCollections: true })).summaries[0]
    : (await session.summaries([summaryId]))[0]);
  if (summary?.status !== 'available' || summary.disclosure !== 'public'
    || !generic && summary.type !== (kind === 'zone' ? 'realm' : kind)) throw new WorkReadMissing('Follow target is unavailable');
  return { id: target, kind, name: summary.name, icon: summary.avatar,
    realm: kind === 'zone' || kind === 'realm' ? summaryId : owner,
    href: kind === 'work' ? `/w/${target.slice(-36)}` : kind === 'concept' ? `/concepts/${target.slice(-36)}`
      : kind === 'realm' || kind === 'zone' ? `/r/${summaryId.slice(-36)}`
        : kind === 'release' ? `/releases/${target.slice(-36)}` : summary.address.prefix + summary.address.key };
}

type FollowTarget = Static<typeof followTarget>;

/** readFollowTarget for a page of Works or Realms: one public-graph query and
 * one summary batch (the caller's, when given). A hidden target is absent. */
export async function readFollowTargets(session: WorkReadSession, targets: readonly string[],
  kind: 'work' | 'realm', summaries?: ReadonlyMap<string, ResourceSummary>): Promise<Map<string, FollowTarget>> {
  if (session.principal) throw new WorkReadUnavailable('Public follow reader required');
  const ids = [...new Set(targets)];
  const result = new Map<string, FollowTarget>();
  if (!ids.length) return result;
  const values = ids.map(iri).join(' ');
  const missing = ids.filter(id => !summaries?.has(id));
  const [rows, fetched] = await Promise.all([kind === 'work'
    ? session.query(`SELECT DISTINCT ?work WHERE { VALUES ?work { ${values} } ${publicWork('?work', '?main')} }
      LIMIT ${ids.length + 1}`, ids.length)
    : session.query(`SELECT ?realm WHERE { GRAPH ${iri(GRAPHS.current)} { VALUES ?realm { ${values} }
      ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
      FILTER NOT EXISTS { ?realm rv:protectionHead ?protection }
    } } LIMIT ${ids.length + 1}`, ids.length),
  session.summaries(missing)]);
  const visible = rows.map(row => row[kind]?.value);
  // readFollowTarget bounds each target's relation to one row.
  if (new Set(visible).size !== visible.length) throw new WorkReadLimit('Read exceeds its bounded relation');
  const all = new Map([...summaries ?? [], ...fetched.map(summary => [summary.reference, summary] as const)]);
  for (const id of ids) {
    const summary = all.get(id);
    if (!visible.includes(id) || summary?.status !== 'available' || summary.disclosure !== 'public'
      || summary.type !== kind) continue;
    result.set(id, { id, kind, name: summary.name, icon: summary.avatar,
      realm: kind === 'realm' ? id : null, href: kind === 'work' ? `/w/${id.slice(-36)}` : `/r/${id.slice(-36)}` });
  }
  return result;
}

async function spaceFollowTargets(session: WorkReadSession, spaces: readonly string[],
  reader?: { principal: VerifiedPrincipal; agent: string }) {
  const result = new Map<string, Static<typeof followTarget>>();
  if (!spaces.length) return result;
  const rows = await session.query(`SELECT ?space ?realm ?zone WHERE { VALUES ?space { ${spaces.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?space a rv:Space .
      OPTIONAL { ?space rv:realmCapability ?realm . ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
        FILTER NOT EXISTS { ?realm rv:protectionHead ?protection } }
      OPTIONAL { ?space rv:zoneCapability ?zone . ?zone a rv:Zone ; rv:space ?space ; rv:zoneState rv:Active .
        FILTER NOT EXISTS { ?zone rv:protectionHead ?zoneProtection } }
      FILTER NOT EXISTS { ?space rv:realmCapability ?attachedRealm FILTER(!BOUND(?realm)) }
      FILTER(BOUND(?realm) || BOUND(?zone))
    } } LIMIT ${spaces.length+1}`,spaces.length);
  if (new Set(rows.map(row => row.space?.value)).size !== rows.length) throw new WorkReadUnavailable('Space identities are ambiguous');
  const summaries = await readResourceSummaries(session.deps.environment,session.deps.media?.store,
    { realmReadProof: async realm => reader
      ? await session.deps.access.realmReadProof?.(reader.principal,reader.agent,realm) ?? null : null,
      canReadSemantic: async resource => {
        // Only Zone-only Spaces use Zone authority. A semantic grant must never
        // substitute for membership on a Space with an active Realm.
        const row = rows.find(row => !row.realm && (row.space?.value === resource || row.zone?.value === resource));
        return !!(row?.zone && reader && await session.deps.access.canReadSemanticResource?.(reader.principal, reader.agent, row.zone.value));
      } },
    { resources: rows.map(row => (row.realm ?? row.zone)!.value),context: DEFAULT_MEDIA_CONTEXT,language: session.options.language ?? null });
  const names = new Map(summaries.summaries.map(summary => [summary.reference,summary]));
  for (const row of rows) {
    const summary = names.get((row.realm ?? row.zone)!.value);
    if (summary?.status==='available') result.set(row.space!.value,{ id: row.space!.value,kind: 'space',
      name: summary.name,icon: summary.avatar,realm: row.realm?.value ?? null,
      href: row.realm ? `/r/${row.realm.value.slice(-36)}` : summary.address.prefix + summary.address.key });
  }
  return result;
}

const agentFollowTarget = (agent: import('../profiles/read.ts').AgentCard): Static<typeof followTarget> => ({
  id: agent.id, kind: 'agent', name: { value: agent.displayName,language: 'und',direction: 'ltr',basis: 'fallback' },
  icon: { kind: 'fallback',policy: 'avatar-fallback-v1',key: agent.id,resourceType: 'agent' },realm: null,href: agent.links.profile });

export async function readFollows(session: WorkReadSession, store: FollowsStore,
  principal: VerifiedPrincipal, agent: string, kind?: FollowKind, includeNewSince = false,
  query: { q?: string; order?: 'recent' | 'pinned' } = {}) {
  const identity = await store.matches(principal, agent, []);
  const orderRevision = identity.revision ?? 'none';
  const cursorPosition = { dataEpoch: session.position.dataEpoch, sequence: '0' };
  const binding = ['follows-v1', identity.owner, agent, kind ?? null,
    session.options.language ?? null, query.q ?? null, query.order ?? 'recent'];
  const cursor = decodeReadCursor(session.options.cursor, binding, cursorPosition);
  if (cursor && cursor.order !== orderRevision) throw new WorkReadMoved('Follows changed');
  const limit = Math.min(session.options.limit ?? 20, FOLLOWS_COST.candidates);
  const page = await store.manage(principal, agent, cursor?.after ?? null, kind, query.order ?? 'recent', limit, query.q);
  if (page.revision !== identity.revision) throw new WorkReadMoved('Follows changed');
  const items: Static<typeof followsPage>['items'] = [];
  const unavailable = (row: Pick<FollowRow, 'target' | 'kind' | 'revision' | 'level' | 'source' | 'pin_position'>) => ({
    id: row.target, kind: row.kind, available: false as const, revision: row.revision,
    ...followMetadata(row), name: null, icon: null, realm: null, href: null });
  const ids = page.rows.slice(0, limit).filter(row => ['work', 'realm', 'concept'].includes(row.kind))
    .map(row => row.target);
  const summaries = new Map((await session.summaries(ids)).map(summary => [summary.reference, summary]));
  const spaces = page.rows.slice(0,limit).filter(row => row.kind==='space').map(row => row.target);
  const agents = page.rows.slice(0,limit).filter(row => row.kind==='agent').map(row => row.target);
  const [spaceTargets,agentTargets] = await Promise.all([spaceFollowTargets(session,spaces,{ principal,agent }),readAgentCards(session,agents)]);
  for (const row of page.rows.slice(0, limit)) {
    try {
      const target = row.kind==='space' ? spaceTargets.get(row.target) : row.kind==='agent'
        ? agentTargets.has(row.target) ? agentFollowTarget(agentTargets.get(row.target)!) : undefined
        : await readFollowTarget(session,row.target,row.kind,summaries,{ principal,agent });
      if (!target) throw new WorkReadMissing('Follow target is unavailable');
      items.push({ ...target,
      ...followMetadata(row), available: true, revision: row.revision }); }
    catch (error) { if (!(error instanceof WorkReadMissing)) throw error; items.push(unavailable(row)); }
  }
  const fenced = new Map((await session.summaries(ids)).map(summary => [summary.reference, summary]));
  const [spaceFence,agentFence] = await Promise.all([spaceFollowTargets(session,spaces,{ principal,agent }),readAgentCards(session,agents)]);
  for (const [index, item] of items.entries()) {
    if (!item.available) continue;
    try {
      const after = item.kind==='space' ? spaceFence.get(item.id) : item.kind==='agent'
        ? agentFence.has(item.id) ? agentFollowTarget(agentFence.get(item.id)!) : undefined
        : await readFollowTarget(session,item.id,item.kind,fenced,{ principal,agent });
      if (!after) throw new WorkReadMissing('Follow target is unavailable');
      if (JSON.stringify(after.name)!==JSON.stringify(item.name) || after.href!==item.href) throw new WorkReadMoved('Follow target changed');
    }
    catch (error) {
      if (!(error instanceof WorkReadMissing)) throw error;
      items[index] = unavailable({ ...item, target: item.id, pin_position: item.pinPosition });
    }
  }
  if (includeNewSince) {
    if (!session.deps.homePersonal || !session.deps.feed) throw new WorkReadUnavailable('New activity is unavailable');
    const watermarks = await session.deps.homePersonal.watermarks(principal, agent);
    let verifiedScopes = 0;
    for (const [index, item] of items.entries()) {
      if (!item.available || !['realm', 'zone', 'space'].includes(item.kind) || !item.realm) continue;
      const watermark = watermarks.find(row => row.scope === `realm:${item.realm}`);
      if (!watermark || watermark.data_epoch !== session.position.dataEpoch) {
        items[index] = { ...item, newSince: { state: 'unvisited', count: null, updatedAt: null } };
        continue;
      }
      if (verifiedScopes++ >= FOLLOWS_COST.newSinceScopes) {
        items[index] = { ...item,newSince: { state: 'more-unverified',count: null,updatedAt: watermark.updated_at.toISOString() } };
        continue;
      }
      const head = await readNewSince(session, watermark.sequence,
        `realm:${item.realm}`, { principal, agent });
      items[index] = { ...item, newSince: { state: head.state === 'projecting' ? 'projecting'
        : head.newPosts.value > 0 ? 'new'
          : head.state === 'more' ? 'more-unverified' : 'none',
      count: head.newPosts, updatedAt: watermark.updated_at.toISOString() } };
    }
  }
  if ((await store.matches(principal, agent, [])).revision !== page.revision) throw new WorkReadMoved('Follows changed');
  const last = page.rows[limit - 1];
  const nextCursor = page.rows.length > limit && last ? encodeReadCursor(binding, cursorPosition,
    JSON.stringify({ key: last.order_key, target: last.target }), orderRevision) : null;
  // Transitional Realm/Zone transports keep the existing shell's capability ids.
  // The inventory, CAS and source still belong to the canonical Space.
  if (kind==='realm' || kind==='zone') for (const [index,item] of items.entries()) {
    if (item.kind!=='space' || !item.available) continue;
    const alias = kind==='realm' ? item.realm : (await followSpace(session,item.id))?.aliases
      .find(id => id!==item.id && id!==item.realm);
    if (alias) items[index] = { ...item,id: alias,kind };
  }
  return { profile: 'follows-v1' as const, ...pageResult(session,items,nextCursor), complete: nextCursor === null };
}

type FollowedAuthor = Static<typeof followedAuthorsPage>['items'][number];

/**
 * `/v1/me/follows/authors`: followed Agents and Open Library authors in
 * follow order, eight at a time, each with their newest public Work. An Agent
 * is public as their profile is; an Open Library author while a public Work
 * credits them, as their page. One Agent card batch, one newest-Work read,
 * one name batch and one Work card batch, between two follow revision checks.
 */
export async function readFollowedAuthors(session: WorkReadSession, store: FollowsStore,
  principal: VerifiedPrincipal, agent: string) {
  if (session.principal) throw new WorkReadUnavailable('Public follow reader required');
  const identity = await store.matches(principal, agent, []);
  const binding = ['followed-authors-v1', identity.owner, agent, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  if (cursor && cursor.order !== (identity.revision ?? 'none')) throw new WorkReadMoved('Follows changed');
  const limit = Math.min(session.options.limit ?? FOLLOWED_AUTHORS_COST.authors, FOLLOWED_AUTHORS_COST.authors);
  const page = await store.read(principal, agent, cursor?.after ?? '', AUTHOR_FOLLOW_KINDS, limit);
  if (page.revision !== identity.revision) throw new WorkReadMoved('Follows changed');
  const rows = page.rows.slice(0, limit);
  const agents = rows.filter(row => row.kind === 'agent').map(row => row.target);
  const keys = rows.flatMap(row => row.kind === 'external-author' ? [externalAuthorKey(row.target)!] : []);
  const [cards, newest, names] = await inOrder(readAgentCards(session, agents),
    newestAuthorWorks(session, { agents, keys }), readAuthorNames(session, keys));
  const works = await shelfWorks(session, [...newest.values()]);
  const items = rows.map((row): FollowedAuthor => {
    const unavailable = { id: row.target, kind: row.kind as 'agent' | 'external-author', available: false as const,
      revision: row.revision, name: null, icon: null, realm: null, href: null, newestWork: null };
    const work = newest.get(row.target);
    const newestWork = work ? works.get(work) ?? null : null;
    const icon = { kind: 'fallback' as const, policy: 'avatar-fallback-v1', key: row.target, resourceType: 'agent' };
    if (row.kind === 'agent') {
      const card = cards.get(row.target);
      return card ? { id: row.target, kind: 'agent', available: true, revision: row.revision,
        name: { value: card.displayName, language: 'und', direction: 'ltr', basis: 'fallback' }, icon, realm: null,
        href: card.links.profile, newestWork } : unavailable;
    }
    const key = externalAuthorKey(row.target)!, id = key.slice('/authors/'.length);
    return work ? { id: row.target, kind: 'external-author', available: true, revision: row.revision,
      name: { value: names.get(key)?.displayName ?? id, language: 'und', direction: 'ltr', basis: 'fallback' }, icon,
      realm: null, href: `/authors/open-library/${id}`, newestWork } : unavailable;
  });
  if ((await store.matches(principal, agent, [])).revision !== page.revision) throw new WorkReadMoved('Follows changed');
  const last = rows.at(-1);
  return { profile: 'followed-authors-v1' as const, ...pageResult(session, items,
    page.rows.length > limit && last ? encodeReadCursor(binding, session.position, last.target, identity.revision ?? 'none')
      : null) };
}
