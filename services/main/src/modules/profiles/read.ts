import type { Static } from 'typebox';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { allocateAgentHandle, agentForHandle } from '../agent/handle.ts';
import { avatarImageEligible, DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork, WorkReadMissing,
  WorkReadUnavailable, WorkReadMoved, type WorkReadSession, type ReadRow } from '../work/read-session.ts';
import type { shelfWork } from './read-contract.ts';
import { WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';
import { readWorkRating } from '../work/read-rating.ts';

export function profileAccess(session: WorkReadSession) {
  if (!session.deps.profiles) throw new WorkReadUnavailable('Profile owner is unavailable');
  return session.deps.profiles;
}
export function field(row: ReadRow, key: string): string {
  if (!row[key]) throw new WorkReadUnavailable('Read field is unavailable');
  return row[key]!.value;
}
export const publicAgent = (agent: string) => `GRAPH ${iri(GRAPHS.current)} {
  ${agent} a rv:Agent ; rv:head ?agentHead ; rv:agentKind ?agentKind ; rdfs:label ?displayName .
  OPTIONAL { ${agent} rv:profileHandle ?savedHandle }
  OPTIONAL { ${agent} rv:profileDisclosure ?profileDisclosure }
  FILTER(!BOUND(?profileDisclosure) || ?profileDisclosure = rv:Public)
  FILTER NOT EXISTS { ${agent} a rv:AgentTombstone }
  FILTER NOT EXISTS { ${agent} rv:protectionHead ?agentProtection }
  FILTER NOT EXISTS { ${agent} rv:profileDisclosure rv:Private } }
  GRAPH ${iri(GRAPHS.revisions)} { ?agentHead a rv:RevisionAnchor ; rv:component ${agent} ;
    rv:modelRevision <https://rezics.com/definition/agent-provision-v1> .
    FILTER NOT EXISTS { ?agentHead a rv:ErasedRevision } }
  BIND(COALESCE(?savedHandle, CONCAT("agent-", STRAFTER(STR(${agent}), "https://rezics.com/id/"))) AS ?handle)`;
// The original provision profile already declares every Agent public. Legacy
// heads use the same injective address allocation without writing during a GET.

export async function readAgent(session: WorkReadSession, agent: string) {
  const owner = profileAccess(session);
  const before = await owner.agentFence(agent);
  if (!before) throw new WorkReadMissing('Agent unavailable');
  const rows = await session.query(`SELECT ?displayName ?agentKind ?handle ?agentHead ?profileHead ?predecessor
    ?bio ?avatarSelection WHERE { ${publicAgent(iri(agent))}
    GRAPH ${iri(GRAPHS.current)} { OPTIONAL { ${iri(agent)} rv:publicProfileHead ?profileHead }
      OPTIONAL { ${iri(agent)} rv:profileBio ?bio }
      OPTIONAL { ${iri(agent)} rv:profileAvatarSelection ?avatarSelection } }
    OPTIONAL { FILTER(BOUND(?profileHead)) GRAPH ${iri(GRAPHS.revisions)} {
      ?profileHead a rv:AgentPublicProfileRevision ;
      rv:component ${iri(agent)} ; rv:predecessor ?predecessor . } }
    } LIMIT 2`, 2);
  if (!rows.length) throw new WorkReadMissing('Agent unavailable');
  const row = rows[0]!;
  const kinds: Record<string, 'person' | 'organization' | 'service'> = {
    [`${RV}PersonAgent`]: 'person', [`${RV}OrganizationAgent`]: 'organization', [`${RV}ServiceAgent`]: 'service' };
  const kind = kinds[field(row, 'agentKind')];
  const displayName = field(row, 'displayName');
  if (rows.length !== 1 || !kind || !displayName || displayName.length > 200
    || (row.profileHead && !row.predecessor)
    || field(row, 'handle') !== allocateAgentHandle(agent)) throw new WorkReadUnavailable('Agent profile is ambiguous');
  const revision = row.profileHead?.value ?? field(row, 'agentHead');
  const bio = row.bio ? { text: row.bio.value, language: row.bio['xml:lang'] ?? '' } : null;
  if (bio && (!bio.text || bio.text.length > 500
    || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u.test(bio.language))) {
    throw new WorkReadUnavailable('Agent bio is invalid');
  }
  const savedAvatar = row.avatarSelection?.value ?? null;
  let avatarSelection: string | null = null;
  if (savedAvatar) {
    if (!session.deps.media?.store) throw new WorkReadUnavailable('Agent avatar owner is unavailable');
    try {
      const mediaRow = (await session.deps.media.store.avatarRows([agent], DEFAULT_MEDIA_CONTEXT)).rows.get(agent);
      if (mediaRow?.selection === savedAvatar && avatarImageEligible(mediaRow)) avatarSelection = savedAvatar;
    } catch { throw new WorkReadUnavailable('Agent avatar owner is unavailable'); }
  }
  const library = await owner.visibility.read(agent);
  let currentHandle: string;
  try { currentHandle = await session.deps.agentHandles?.current(agent) ?? field(row, 'handle'); }
  catch { throw new WorkReadUnavailable('Agent handle owner is unavailable'); }
  const path = `/v1/agents/${agent.slice(-36)}`;
  const ownerVisible = library.visibility !== 'public' && !!session.principal
    && session.options.actingSubject === agent
    && !!await session.deps.access.canReadAsBaselineMember?.(session.principal, agent);
  const statusShelves = library.visibility === 'public' ? `${path}/shelves`
    : ownerVisible ? `/v1/me/shelves?actingSubject=${encodeURIComponent(agent)}` : null;
  if (await owner.agentFence(agent) !== before
    || (await owner.visibility.read(agent)).version !== library.version) {
    throw new WorkReadMoved('Agent profile changed');
  }
  return { profile: 'agent-read-v1' as const, id: agent, displayName, kind, revision, bio,
    avatarSelection, avatarUrl: avatarSelection ? `/v1/media/avatars/${avatarSelection}` : null,
    handle: currentHandle, disclosure: 'public' as const, sourcePosition: session.position,
    library: { visibility: library.visibility, statusShelvesVisible: statusShelves !== null },
    links: { profile: `/@${currentHandle}`, works: `${path}/works`, collections: `${path}/collections`,
      ...(statusShelves ? { statusShelves } : {}) } };
}

export async function readHandle(session: WorkReadSession, handle: string) {
  let resolved;
  try { resolved = session.deps.agentHandles
    ? await session.deps.agentHandles.resolve(handle)
    : (agentForHandle(handle) ? { agent: agentForHandle(handle)!, state: 'native' as const,
      redirect: false } : null); }
  catch { throw new WorkReadUnavailable('Agent handle owner is unavailable'); }
  if (!resolved) throw new WorkReadMissing('Agent unavailable');
  const profile = await readAgent(session, resolved.agent);
  return { ...profile, resolution: { requestedHandle: handle, state: resolved.state,
    redirect: resolved.redirect || profile.handle !== handle,
    canonical: profile.links.profile } };
}

export function pageBasis(session: WorkReadSession, family: string, subject: unknown) {
  const binding = ['profiles-v1', family, subject, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  return { limit: session.options.limit ?? 20, binding, after: cursor?.after ?? '' };
}
export function nextPage(session: WorkReadSession, binding: unknown, ids: string[], limit: number) {
  return ids.length > limit ? encodeReadCursor(binding, session.position, ids[limit - 1]!) : null;
}

/** Two bounded summary batches: hydration and the final Access/title fence. */
export async function shelfWorks(session: WorkReadSession, works: string[]) {
  const ids = [...new Set(works)];
  const summaries = await session.summaries(ids);
  const confirmed = await session.summaries(ids);
  const result = new Map<string, Static<typeof shelfWork>>();
  ids.forEach((id, i) => {
    const summary = summaries[i];
    const final = confirmed[i];
    if (summary?.status !== 'available' || summary.type !== 'work' || final?.status !== 'available') return;
    if (JSON.stringify(summary) !== JSON.stringify(final)) throw new WorkReadMoved('Summary changed during read');
    result.set(id, { id, title: summary.name, cover: summary.avatar });
  });
  return result;
}

export async function readAgentWorks(session: WorkReadSession, agent: string, context?: string) {
  await readAgent(session, agent);
  const { limit, binding, after } = pageBasis(session, 'works', agent);
  const rows = await session.query(`SELECT DISTINCT ?id WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:agent ${iri(agent)} ;
      rv:work ?id ; rv:creditRevision ?creditHead . }
    GRAPH ${iri(GRAPHS.revisions)} { ?creditHead a rv:NativeAgentCreditRevision ; rv:component ?credit ;
      rv:agent ${iri(agent)} ; rv:work ?id . FILTER NOT EXISTS { ?creditHead a rv:ErasedRevision } }
    ${publicWork('?id', '?main')}
    FILTER(STR(?id) > ${lit(after)}) } ORDER BY STR(?id) LIMIT ${limit + 1}`, limit + 1);
  const ids = rows.map(row => field(row, 'id'));
  const page = ids.slice(0, limit);
  const cards = await shelfWorks(session, page);
  const visible = page.filter(id => cards.has(id));
  const serial = await readSerialSummaries(session, visible);
  const typeRows = visible.length ? await session.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${visible.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type .
      VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} } }
  } LIMIT ${visible.length * WORK_SEMANTIC_TYPES.length + 1}`,
  visible.length * WORK_SEMANTIC_TYPES.length) : [];
  if (typeRows.some(row => !row.work || !row.type || !cards.has(row.work.value))
    || new Set(typeRows.map(row => `${row.work!.value}\0${row.type!.value}`)).size !== typeRows.length) {
    throw new WorkReadUnavailable('Agent Work types are ambiguous');
  }
  const types = new Map(visible.map(id => [id,
    typeRows.filter(row => row.work!.value === id).map(row => row.type!.value).sort()]));
  const ratings = new Map<string, Awaited<ReturnType<typeof readWorkRating>>>();
  if (context) for (const id of visible) ratings.set(id, await readWorkRating(session, id, context));
  const credits = page.length ? await session.query(`SELECT ?work ?credit ?role WHERE {
    VALUES ?work { ${page.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:agent ${iri(agent)} ;
      rv:work ?work ; rv:creditRevision ?revision ; schema:roleName ?role . }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeAgentCreditRevision ; rv:component ?credit ;
      rv:work ?work ; rv:agent ${iri(agent)} ; schema:roleName ?role .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
  } LIMIT ${page.length * 3 + 1}`, page.length * 3) : [];
  const items = page.flatMap(id => {
    const card = cards.get(id);
    if (!card) return [];
    const attribution = credits.filter(row => field(row, 'work') === id).map(row => {
      const role = field(row, 'role');
      if (!['author', 'translator', 'editor'].includes(role)) throw new WorkReadUnavailable('Invalid credit role');
      return { credit: field(row, 'credit'), role: role as 'author' | 'translator' | 'editor' };
    });
    if (!attribution.length || new Set(attribution.map(item => item.role)).size !== attribution.length) {
      throw new WorkReadUnavailable('Attribution is ambiguous');
    }
    const rating = ratings.get(id);
    const sum = rating?.distribution.reduce((total, bin) => total + bin.value * bin.count, 0) ?? 0;
    return [{ ...card, types: types.get(id) ?? [], tagline: serial.get(id)!.tagline,
      completionStatus: serial.get(id)!.completionStatus,
      rating: rating?.status === 'available' && rating.count && rating.context && rating.scale
        ? { context: rating.context, count: rating.count, sum, mean: rating.mean!,
          scale: { min: 1 as const, max: rating.scale.max as 5 | 10 } } : null,
      attribution }];
  });
  await readAgent(session, agent);
  return pageResult(session, items, nextPage(session, binding, ids, limit));
}

export async function readAgentCollections(session: WorkReadSession, agent: string) {
  await readAgent(session, agent);
  const { limit, binding, after } = pageBasis(session, 'collections', agent);
  // Public partition precedes LIMIT: private shelves never affect cursor or count.
  const rows = await session.query(`SELECT ?id ?revision ?name ?kind ?structure WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?id a rv:Collection ; rv:curator ${iri(agent)} ;
      rv:collectionState rv:Active ; rv:disclosure rv:Public ; rv:collectionHead ?revision ;
      schema:name ?name ; rv:collectionKind ?kind ; rv:structure ?structure .
      FILTER NOT EXISTS { ?id rv:disclosure rv:Private }
      FILTER NOT EXISTS { ?id rv:protectionHead ?protection } }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:CollectionRevision ; rv:component ?id .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
    FILTER(STR(?id) > ${lit(after)}) } ORDER BY STR(?id) LIMIT ${limit + 1}`, limit + 1);
  if (new Set(rows.map(row => field(row, 'id'))).size !== rows.length) throw new WorkReadUnavailable('Ambiguous collection');
  const items = rows.slice(0, limit).map(row => {
    const kind = field(row, 'kind');
    if (![`${RV}StaticCollection`, `${RV}CapturedCollection`].includes(kind)) throw new WorkReadUnavailable('Invalid collection kind');
    return { id: field(row, 'id'), revision: field(row, 'revision'), name: field(row, 'name'),
      kind: kind === `${RV}StaticCollection` ? 'static' as const : 'captured' as const,
      disclosure: 'public' as const, structure: field(row, 'structure') };
  });
  await readAgent(session, agent);
  return pageResult(session, items, nextPage(session, binding, rows.map(row => field(row, 'id')), limit));
}
