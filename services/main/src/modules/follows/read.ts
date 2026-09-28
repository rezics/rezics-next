import type { Static } from 'typebox';
import { readAgent } from '../profiles/read.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadLimit, WorkReadMissing, WorkReadMoved,
  publicWork, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { ResourceSummary } from '../media/summary.ts';
import { FOLLOWS_COST, type followsPage, type followTarget, type FollowKind } from './contract.ts';
import type { FollowsStore } from './store.ts';
import { readNewSince } from '../feed/new-since.ts';

/** Must receive an anonymous session: a bearer never widens follow disclosure. */
export async function readFollowTarget(session: WorkReadSession, target: string, kind: FollowKind,
  summaries?: ReadonlyMap<string, ResourceSummary>): Promise<Static<typeof followTarget>> {
  if (session.principal) throw new WorkReadUnavailable('Public follow reader required');
  if (kind === 'agent') {
    const agent = await readAgent(session, target);
    return { id: target, kind, name: { value: agent.displayName, language: 'und', direction: 'ltr', basis: 'fallback' },
      icon: { kind: 'fallback', policy: 'avatar-fallback-v1', key: target, resourceType: 'agent' },
      realm: null, href: agent.links.profile };
  }
  let summaryId = target;
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
    realm: kind === 'zone' || kind === 'realm' ? summaryId : null,
    href: kind === 'work' ? `/w/${target.slice(-36)}` : `/r/${summaryId.slice(-36)}` };
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
  const ids = page.rows.slice(0, limit).filter(row => row.kind === 'work' || row.kind === 'realm').map(row => row.target);
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
