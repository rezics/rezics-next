import { readEpochOrder } from '../discovery/lineage.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { fenceWorkBasis, readWorkBasis } from '../work/read-header.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadLimit,
  WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { WORK_ACTIVITY_COST } from './read-contract.ts';

type Kind = 'metadata-revision' | 'publication-decision' | 'reply-placement';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const contentRevision = 'urn:rezics:content:revision:';

function cursorOrder(cursor: ReturnType<typeof decodeReadCursor>) {
  if (!cursor) return null;
  const parts = cursor.order.split(':');
  if (parts.length !== 2 || !parts.every(part => /^\d+$/.test(part))) {
    throw new WorkReadUnavailable('Cursor ordering is unavailable');
  }
  return parts;
}
function afterFilter(after: string, order: string[] | null) {
  return order ? `FILTER(?epochOrder > ${order[0]} || (?epochOrder = ${order[0]}
    && (?sequence < ${order[1]} || (?sequence = ${order[1]} && STR(?id) > ${lit(after)}))))` : '';
}
function field(row: Record<string, { value: string } | undefined>, key: string): string {
  const value = row[key]?.value;
  if (!value) throw new WorkReadUnavailable('Activity row is incomplete');
  return value;
}
function checkedRows(rows: Record<string, { value: string } | undefined>[]) {
  if (rows.some(row => !native.test(row.id?.value ?? '') || !/^\d+$/.test(row.sequence?.value ?? '')
    || !/^\d+$/.test(row.epochOrder?.value ?? '') || !row.revisionEpoch?.value)
    || new Set(rows.map(row => row.id!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Activity order is ambiguous');
  }
}
function nextCursor(session: WorkReadSession, binding: unknown,
  rows: Record<string, { value: string } | undefined>[], limit: number) {
  const last = rows[limit - 1];
  return rows.length > limit && last ? encodeReadCursor(binding, session.position,
    field(last, 'id'), `${field(last, 'epochOrder')}:${field(last, 'sequence')}`) : null;
}

/** Candidate selection precedes hydration. Native graph work is O(D log D) for
 * D placements of the Work, including hidden rows; LIMIT bounds output, not scan cost. */
export async function readWorkDiscussion(session: WorkReadSession, work: string, realm?: string) {
  const basis = await readWorkBasis(session, work);
  if (!session.deps.realmReplies || !session.deps.content) {
    throw new WorkReadUnavailable('Reply or Content owner is unavailable');
  }
  if (realm) await session.realm(realm);
  const limit = session.options.limit ?? WORK_ACTIVITY_COST.pageSize;
  const binding = ['work-discussion-v1', work, realm ?? null,
    session.options.language ?? null, session.options.actingSubject ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const epochs = await readEpochOrder(session);
  const rows = await session.query(`SELECT ?id ?reply ?realm ?revision ?review ?sequence ?revisionEpoch ?epochOrder WHERE {
    ${epochs}
    GRAPH ${iri(GRAPHS.current)} {
      ?slot a rv:RealmReplySlot ; rv:rootTarget ${iri(work)} ; rv:realm ?realm ;
        rv:reply ?reply ; rv:replyPlacementHead ?id .
      ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
      ?space a rv:Space ; rv:realmCapability ?realm . ${realm ? '' : '?space rv:disclosure rv:Public .'} }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?id a rv:RealmReplyPlacement ; rv:realm ?realm ; rv:reply ?reply ;
        rv:rootTarget ${iri(work)} ; rv:contentRevision ?revision ;
        rv:reviewDecision ?review ; rv:placementOutcome rv:Accepted ;
        rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence . }
    ${realm ? `FILTER(?realm = ${iri(realm)})` : ''}
    ${afterFilter(cursor?.after ?? '', cursorOrder(cursor))}
  } ORDER BY ?epochOrder DESC(?sequence) STR(?id) LIMIT ${limit + 1}`, limit + 1);
  checkedRows(rows);
  const page = rows.slice(0, limit);
  const visiblePage = [];
  for (const row of page) {
    const revision = field(row, 'revision');
    const id = revision.startsWith(contentRevision) ? revision.slice(contentRevision.length) : '';
    if (!uuid.test(id)) throw new WorkReadUnavailable('Reply revision identity is invalid');
    const reply = field(row, 'reply');
    const realmId = field(row, 'realm');
    const visible = await session.deps.realmReplies.visible(realmId, reply, session.principal ?? undefined, session.options.actingSubject);
    if (visible?.placement === field(row, 'id') && visible.revisionId === id
      && field(row, 'review') === `urn:rezics:realm-review:${visible.reviewDecisionId}`) {
      visiblePage.push({ row, revisionId: id, realmId, reply });
    }
  }
  // One reviewed revision may be placed in several Realms. Content's batch
  // reader requires distinct revisions, so hydrate each exact revision once.
  const uniqueRevisions = [...new Set(visiblePage.map(item => item.revisionId))];
  const exact = await session.deps.content.readExactBatch(uniqueRevisions, async ids => new Set(ids));
  const bodies = new Map(uniqueRevisions.map((id, index) => [id, exact[index]]));
  const items = [];
  for (const { row, revisionId, realmId, reply } of visiblePage) {
    const review = field(row, 'review');
    const visible = await session.deps.realmReplies.visible(realmId, reply, session.principal ?? undefined, session.options.actingSubject);
    const body = bodies.get(revisionId);
    if (!visible || visible.placement !== field(row, 'id')
      || visible.revisionId !== revisionId
      || review !== `urn:rezics:realm-review:${visible.reviewDecisionId}`
      || body?.status === 'erased' || body?.status === 'missing' || body?.status === 'denied') continue;
    if (body?.status !== 'available') throw new WorkReadUnavailable('Reply bytes are unavailable');
    if (body.reference.resourceId !== reply || typeof body.body.body !== 'string') {
      throw new WorkReadUnavailable('Reply body differs from its identity');
    }
    if (Buffer.byteLength(body.body.body, 'utf8') > 1_048_576) throw new WorkReadLimit('Reply body exceeds its budget');
    items.push({ reply, realm: realmId, placement: field(row, 'id'), revisionId,
      body: body.body.body, dataEpoch: field(row, 'revisionEpoch'), sequence: field(row, 'sequence') });
  }
  await fenceWorkBasis(session, basis);
  return pageResult(session, items, nextCursor(session, binding, rows, limit));
}

/** Current public decisions only. Actor identities and historical text stay out
 * of this feed. The Work-scoped native scan is O(H log H) for H retained events. */
export async function readWorkActivityHistory(session: WorkReadSession, work: string, kind?: Kind) {
  const basis = await readWorkBasis(session, work);
  const limit = session.options.limit ?? WORK_ACTIVITY_COST.pageSize;
  const binding = ['work-activity-history-v1', work, kind ?? null,
    session.options.language ?? null, session.options.actingSubject ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const epochs = await readEpochOrder(session);
  const rows = await session.query(`SELECT ?id ?kind ?realm ?reply ?revision ?review ?sequence ?revisionEpoch ?epochOrder WHERE {
    ${epochs}
    { GRAPH ${iri(GRAPHS.revisions)} {
        ?id a rv:RevisionAnchor ; rv:component ${iri(work)} ;
          rv:modelRevision <https://rezics.com/definition/work-metadata-v1> ;
          rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ?id a rv:ErasedRevision } }
      BIND("metadata-revision" AS ?kind) }
    UNION { GRAPH ${iri(GRAPHS.current)} {
        ?contribution a rv:TextContribution ; rv:work ${iri(work)} ; rv:publicationHead ?id . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?id a rv:PublicationDecision ; rv:work ${iri(work)} ;
          rv:contribution ?contribution ; rv:disclosure rv:Public ;
          rv:selectedDraft ?draft ; rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
      BIND("publication-decision" AS ?kind) }
    UNION { GRAPH ${iri(GRAPHS.current)} {
        ?slot a rv:RealmReplySlot ; rv:rootTarget ${iri(work)} ;
          rv:realm ?realm ; rv:replyPlacementHead ?id .
        ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
        ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?id a rv:RealmReplyPlacement ; rv:rootTarget ${iri(work)} ;
          rv:placementOutcome rv:Accepted ; rv:realm ?realm ; rv:reply ?reply ;
          rv:contentRevision ?revision ; rv:reviewDecision ?review ;
          rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence . }
      BIND("reply-placement" AS ?kind) }
    ${kind ? `FILTER(?kind = ${lit(kind)})` : ''}
    ${afterFilter(cursor?.after ?? '', cursorOrder(cursor))}
  } ORDER BY ?epochOrder DESC(?sequence) STR(?id) LIMIT ${limit + 1}`, limit + 1);
  checkedRows(rows);
  const page = rows.slice(0, limit);
  const items = [];
  for (const row of page) {
    const eventKind = field(row, 'kind') as Kind;
    const id = field(row, 'id');
    if (!['metadata-revision', 'publication-decision', 'reply-placement'].includes(eventKind)) {
      throw new WorkReadUnavailable('History kind is invalid');
    }
    if (eventKind === 'reply-placement') {
      if (!session.deps.realmReplies) throw new WorkReadUnavailable('Reply owner is unavailable');
      const realm = field(row, 'realm');
      const reply = field(row, 'reply');
      const visible = await session.deps.realmReplies.visible(realm, reply, session.principal ?? undefined, session.options.actingSubject);
      if (!visible || visible.placement !== id
        || field(row, 'revision') !== `${contentRevision}${visible.revisionId}`
        || field(row, 'review') !== `urn:rezics:realm-review:${visible.reviewDecisionId}`) continue;
    }
    items.push({ id, kind: eventKind, dataEpoch: field(row, 'revisionEpoch'),
      sequence: field(row, 'sequence'), href: eventKind === 'metadata-revision'
        ? `/v1/revisions/${id.slice(-36)}` : null });
  }
  await fenceWorkBasis(session, basis);
  return pageResult(session, items, nextCursor(session, binding, rows, limit));
}
