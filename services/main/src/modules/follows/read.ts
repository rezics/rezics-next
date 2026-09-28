import type { Static } from 'typebox';
import { FOLLOWED_AUTHORS_COST, newestAuthorWorks, readExternalAuthorTarget } from '../author-page/follow.ts';
import { readAgent, readAgentCards, shelfWorks } from '../profiles/read.ts';
import { readAuthorNames } from '../source/author-name-read.ts';
import { resolveConcepts } from '../concept-page/read.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadLimit, WorkReadMissing, WorkReadMoved,
  publicWork, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { ResourceSummary } from '../media/summary.ts';
import { AUTHOR_FOLLOW_KINDS, externalAuthorKey, FOLLOWS_COST, type followedAuthorsPage, type followsPage,
  type followTarget, type FollowKind } from './contract.ts';
import type { FollowsStore } from './store.ts';
import { readNewSince } from '../feed/new-since.ts';
import { inOrder } from '../feed/settled.ts';

/** Must receive an anonymous session: a bearer never widens follow disclosure. */
export async function readFollowTarget(session: WorkReadSession, target: string, kind: FollowKind,
  summaries?: ReadonlyMap<string, ResourceSummary>): Promise<Static<typeof followTarget>> {
  if (session.principal) throw new WorkReadUnavailable('Public follow reader required');
  if (kind === 'external-author') return readExternalAuthorTarget(session, target);
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
  const summary = summaries?.get(summaryId) ?? (await session.summaries([summaryId]))[0];
  if (summary?.status !== 'available' || summary.disclosure !== 'public'
    || summary.type !== (kind === 'zone' ? 'realm' : kind)) throw new WorkReadMissing('Follow target is unavailable');
  return { id: target, kind, name: summary.name, icon: summary.avatar,
    realm: kind === 'zone' || kind === 'realm' ? summaryId : owner,
    href: kind === 'work' ? `/w/${target.slice(-36)}` : kind === 'concept' ? `/concepts/${target.slice(-36)}`
      : `/r/${summaryId.slice(-36)}` };
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

export async function readFollows(session: WorkReadSession, store: FollowsStore,
  principal: VerifiedPrincipal, agent: string, kind?: FollowKind, includeNewSince = false) {
  const identity = await store.matches(principal, agent, []);
  const binding = ['follows-v1', identity.owner, agent, kind ?? null,
    session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  if (cursor && cursor.order !== (identity.revision ?? 'none')) throw new WorkReadMoved('Follows changed');
  const limit = Math.min(session.options.limit ?? 20, FOLLOWS_COST.candidates);
  const page = await store.read(principal, agent, cursor?.after ?? '', kind, limit);
  if (page.revision !== identity.revision) throw new WorkReadMoved('Follows changed');
  const items: Static<typeof followsPage>['items'] = [];
  const unavailable = (row: { target: string; kind: FollowKind; revision: string }) => ({
    id: row.target, kind: row.kind, available: false as const, revision: row.revision,
    name: null, icon: null, realm: null, href: null });
  const ids = page.rows.slice(0, limit).filter(row => ['work', 'realm', 'concept'].includes(row.kind))
    .map(row => row.target);
  const summaries = new Map((await session.summaries(ids)).map(summary => [summary.reference, summary]));
  for (const row of page.rows.slice(0, limit)) {
    try { items.push({ ...await readFollowTarget(session, row.target, row.kind, summaries), available: true, revision: row.revision }); }
    catch (error) { if (!(error instanceof WorkReadMissing)) throw error; items.push(unavailable(row)); }
  }
  const fenced = new Map((await session.summaries(ids)).map(summary => [summary.reference, summary]));
  for (const [index, item] of items.entries()) {
    if (!item.available) continue;
    try { await readFollowTarget(session, item.id, item.kind, fenced); }
    catch (error) {
      if (!(error instanceof WorkReadMissing)) throw error;
      items[index] = unavailable({ ...item, target: item.id });
    }
  }
  if (includeNewSince) {
    if (!session.deps.homePersonal || !session.deps.feed) throw new WorkReadUnavailable('New activity is unavailable');
    const watermarks = await session.deps.homePersonal.watermarks(principal, agent);
    for (const [index, item] of items.entries()) {
      if (!item.available || !['realm', 'zone'].includes(item.kind) || !item.realm) continue;
      const watermark = watermarks.find(row => row.scope === `realm:${item.realm}`);
      if (!watermark || watermark.data_epoch !== session.position.dataEpoch) {
        items[index] = { ...item, newSince: { state: 'unvisited', count: null, updatedAt: null } };
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
  return { profile: 'follows-v1' as const, ...pageResult(session, items,
    page.rows.length > limit && last ? encodeReadCursor(binding, session.position, last.target, identity.revision ?? 'none') : null) };
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
