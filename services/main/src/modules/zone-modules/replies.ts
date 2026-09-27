import { readEpochOrder } from '../discovery/lineage.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork,
  WorkReadInvalid, WorkReadUnavailable, type ReadRow, type WorkReadSession } from '../work/read-session.ts';
import { ZONE_MODULE_COST } from './contract.ts';

type Kind = 'discussions' | 'reader-quotes';
const revisionPrefix = 'urn:rezics:content:revision:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One candidate page and one Content batch. At most 40 exact placement/review
 * checks; native ordering can scan and sort D Realm reply placements. */
export async function readZoneReplies(session: WorkReadSession, realm: string, kind: Kind) {
  await readRealmBasis(session, realm);
  if (!session.deps.realmReplies || !session.deps.content) {
    throw new WorkReadUnavailable('Reply or Content owner is unavailable');
  }
  const limit = session.options.limit ?? ZONE_MODULE_COST.pageSize;
  const binding = ['zone-replies-v1', realm, kind, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const order = cursor?.order.split(':');
  if (order && (order.length !== 2 || !order.every(value => /^\d+$/.test(value)))) {
    throw new WorkReadInvalid('Reply cursor order is invalid');
  }
  const epochs = await readEpochOrder(session);
  const rows = await session.query(`SELECT DISTINCT ?id ?reply ?work ?author ?authorName ?revision ?review
    ?revisionEpoch ?sequence ?epochOrder WHERE {
    ${epochs}
    GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmReplySlot ; rv:realm ${iri(realm)} ;
      rv:rootTarget ?work ; rv:reply ?reply ; rv:replyPlacementHead ?id . }
    GRAPH ${iri(GRAPHS.current)} { ?author a rv:Agent ; rdfs:label ?authorName .
      FILTER NOT EXISTS { ?author rv:profileDisclosure rv:Private }
      FILTER NOT EXISTS { ?author a rv:AgentTombstone }
      FILTER NOT EXISTS { ?author rv:protectionHead ?protection } }
    GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:RealmReplyPlacement ;
      rv:realm ${iri(realm)} ; rv:reply ?reply ; rv:rootTarget ?work ;
      rv:author ?author ; rv:contentRevision ?revision ; rv:reviewDecision ?review ;
      rv:placementOutcome rv:Accepted ; rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence .
      ${kind === 'discussions' ? 'FILTER NOT EXISTS { ?id rv:parentReply ?parent }' : ''} }
    ${publicWork('?work', '?main')}
    ${cursor && order ? `FILTER(?epochOrder > ${order[0]} || (?epochOrder = ${order[0]}
      && (?sequence < ${order[1]} || (?sequence = ${order[1]}
        && STR(?id) > ${lit(cursor.after)}))))` : ''}
  } ORDER BY ?epochOrder DESC(?sequence) STR(?id) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.id || !row.reply || !row.work || !row.author || !row.authorName || !row.review
    || !row.revision?.value.startsWith(revisionPrefix)
    || !uuid.test(row.revision.value.slice(revisionPrefix.length))
    || !row.revisionEpoch || !/^\d+$/.test(row.sequence?.value ?? '')
    || !/^\d+$/.test(row.epochOrder?.value ?? ''))
    || new Set(rows.map(row => row.id!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Realm reply candidates are ambiguous');
  }
  const page = rows.slice(0, limit);
  const visible: { row: ReadRow; revisionId: string }[] = [];
  for (const row of page) {
    const revisionId = row.revision!.value.slice(revisionPrefix.length);
    const proof = await session.deps.realmReplies.visible(realm, row.reply!.value,
      session.principal ?? undefined, session.options.actingSubject);
    if (proof?.placement === row.id!.value && proof.revisionId === revisionId
      && row.review!.value === `urn:rezics:realm-review:${proof.reviewDecisionId}`) {
      visible.push({ row, revisionId });
    }
  }
  const revisions = [...new Set(visible.map(item => item.revisionId))];
  const bodies = revisions.length
    ? await session.deps.content.readExactBatch(revisions, async ids => new Set(ids)) : [];
  const contentBytes = bodies.reduce((total, item) => total + (item.status === 'available'
    ? Buffer.byteLength(item.body.body, 'utf8') : 0), 0);
  if (contentBytes > ZONE_MODULE_COST.contentBytes) {
    throw new WorkReadUnavailable('Realm reply content batch exceeds the read budget');
  }
  const byRevision = new Map(revisions.map((revision, index) => [revision, bodies[index]]));
  const works = [...new Set(visible.map(item => item.row.work!.value))];
  const summaries = await session.summaries(works);
  const names = new Map(works.map((work, index) => [work, summaries[index]]));
  const items = [];
  for (const { row, revisionId } of visible) {
    const proof = await session.deps.realmReplies.visible(realm, row.reply!.value,
      session.principal ?? undefined, session.options.actingSubject);
    const body = byRevision.get(revisionId);
    const summary = names.get(row.work!.value);
    if (!proof || proof.placement !== row.id!.value || proof.revisionId !== revisionId
      || row.review!.value !== `urn:rezics:realm-review:${proof.reviewDecisionId}`
      || body?.status === 'erased' || body?.status === 'missing' || body?.status === 'denied'
      || summary?.status !== 'available' || summary.disclosure !== 'public') continue;
    if (body?.status !== 'available' || body.reference.resourceId !== row.reply!.value
      || typeof body.body.body !== 'string') {
      throw new WorkReadUnavailable('Realm reply body differs from its public placement');
    }
    const excerpt = Array.from(body.body.body.replace(/\s+/g, ' ').trim()).slice(0, 240).join('');
    if (!excerpt || kind === 'reader-quotes' && excerpt.length < 24) continue;
    items.push({ id: row.reply!.value, placement: row.id!.value, author: row.author!.value,
      authorName: row.authorName!.value,
      work: { id: row.work!.value, title: summary.name },
      excerpt, dataEpoch: row.revisionEpoch!.value, sequence: row.sequence!.value });
  }
  await readRealmBasis(session, realm);
  const last = page.at(-1);
  return { profile: kind === 'discussions' ? 'zone-discussions-v1' as const
    : 'zone-reader-quotes-v1' as const, realm,
    ...pageResult(session, items, rows.length > limit && last
      ? encodeReadCursor(binding, session.position, last.id!.value,
        `${last.epochOrder!.value}:${last.sequence!.value}`) : null) };
}
