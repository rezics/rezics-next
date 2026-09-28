import type { Static } from 'typebox';
import { readEpochOrder } from '../discovery/lineage.ts';
import { activityTime, bestKey } from '../feed/ranking.ts';
import { readAgentCards } from '../profiles/read.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork, WorkReadInvalid, WorkReadMissing,
  WorkReadMoved, WorkReadUnavailable, type ReadRow, type WorkReadSession } from '../work/read-session.ts';
import { replySlotIri } from './graph.ts';
import { REALM_THREAD_COST, type realmThread, type realmThreadReply, type realmThreadSummary,
  type threadSort, type threadWindow } from './thread-contract.ts';
import type { PlacedHead, RealmReplyThreadStore, ThreadVote } from './thread-store.ts';

type Sort = Static<typeof threadSort>;
type Window = Static<typeof threadWindow>;
type Summary = Static<typeof realmThreadSummary>;
type Reply = Static<typeof realmThreadReply>;

const revisionPrefix = 'urn:rezics:content:revision:';
const reviewPrefix = 'urn:rezics:realm-review:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WINDOW_MS: Record<Window, number> = { week: 7 * 86_400_000, month: 30 * 86_400_000, all: Infinity };
const closed: ThreadVote = { score: 0, value: 0, revision: null, open: false };

/** A Realm placement head as the graph states it. */
interface Head extends PlacedHead { placement: string; work: string; author: string; rootRevision: string;
  parent: string | null; time: Date; epochOrder: string; sequence: string }

function store(session: WorkReadSession): RealmReplyThreadStore {
  const threads = session.deps.realmReplyThreads;
  if (!threads || !session.deps.content) throw new WorkReadUnavailable('Reply or Content owner is unavailable');
  return threads;
}

// Placement heads in one Realm, as `readPlacementHead` admits them: an accepted
// placement whose root revision and Work stay public and unerased.
const headPattern = (realm: string) => `
  GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmReplySlot ; rv:realm ${iri(realm)} ;
    rv:rootTarget ?work ; rv:reply ?reply ; rv:replyPlacementHead ?id . }
  GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:RealmReplyPlacement ; rv:realm ${iri(realm)} ;
    rv:reply ?reply ; rv:rootTarget ?work ; rv:rootRevision ?rootRevision ; rv:author ?author ;
    rv:contentRevision ?revision ; rv:reviewDecision ?review ; rv:contentPreparation ?preparation ;
    rv:placementOutcome rv:Accepted ; rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence . }
  BIND(IRI(?rootRevision) AS ?rootAnchor)
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?rootAnchor a rv:ErasedRevision } }
  ${publicWork('?work', '?main')}`;

function head(row: ReadRow): Head {
  const revision = row.revision?.value ?? '', review = row.review?.value ?? '';
  const revisionId = revision.slice(revisionPrefix.length), reviewDecisionId = review.slice(reviewPrefix.length);
  if (!row.id?.value || !row.reply?.value || !row.work?.value || !row.author?.value || !row.preparation?.value
    || !row.rootRevision?.value || !revision.startsWith(revisionPrefix) || !uuid.test(revisionId)
    || !review.startsWith(reviewPrefix) || !uuid.test(reviewDecisionId) || !/^\d+$/.test(row.sequence?.value ?? '')) {
    throw new WorkReadUnavailable('Realm reply placement is malformed');
  }
  return { reply: row.reply.value, placement: row.id.value, work: row.work.value, author: row.author.value,
    rootRevision: row.rootRevision.value, revisionId, reviewDecisionId, preparationId: row.preparation.value,
    parent: row.parent?.value ?? null, time: activityTime(row.id.value, new Date(0)).time,
    epochOrder: row.epochOrder?.value ?? '0', sequence: row.sequence!.value };
}

/** Exact placed bodies, in Content's 64-revision batches. Any unreadable body hides its reply. */
async function bodies(session: WorkReadSession, heads: readonly Head[]) {
  const revisions = [...new Set(heads.map(item => item.revisionId))];
  const read = new Map<string, { body: string; language: string | null }>();
  for (let start = 0; start < revisions.length; start += REALM_THREAD_COST.contentBatch) {
    const batch = revisions.slice(start, start + REALM_THREAD_COST.contentBatch);
    const results = await session.deps.content!.readExactBatch(batch, async ids => new Set(ids));
    for (const result of results) {
      if (result.status !== 'available' || typeof result.body.body !== 'string') continue;
      const { language } = result.reference;
      read.set(result.revisionId, { body: result.body.body, language: language.kind === 'tag' ? language.tag : null });
    }
  }
  return new Map(heads.flatMap(item => {
    const body = read.get(item.revisionId);
    return body?.body.trim() ? [[item.reply, body] as const] : [];
  }));
}

/** The Work every listed reply is about, public and titled, or nothing. */
async function works(session: WorkReadSession, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const summaries = await session.summaries(unique);
  return new Map(unique.flatMap((id, index) => {
    const summary = summaries[index];
    return summary?.status === 'available' && summary.disclosure === 'public'
      ? [[id, { id, title: summary.name, cover: summary.avatar }] as const] : [];
  }));
}

async function authors(session: WorkReadSession, ids: readonly string[]) {
  const cards = await readAgentCards(session, ids);
  return (id: string) => {
    const card = cards.get(id);
    return card ? { id, name: card.displayName, handle: card.handle } : null;
  };
}

function reader(session: WorkReadSession) {
  return session.principal && session.options.actingSubject
    ? { principal: session.principal, agent: session.options.actingSubject } : undefined;
}

/** Best is Home's vote and age signal; Top is net score; New is newest first. Ties go newest first. */
function ranked<T extends { time: Date; placement: string }>(rows: readonly T[], sort: Sort,
  score: (row: T) => number): T[] {
  const key = (row: T) => sort === 'top' ? score(row) : sort === 'best' ? bestKey(score(row), row.time.getTime()) : 0;
  return [...rows].sort((a, b) => key(b) - key(a) || b.time.getTime() - a.time.getTime()
    || a.placement.localeCompare(b.placement));
}

/**
 * One page of a Realm's discussions: replies placed in the Realm that answer
 * no other reply. New follows placement order; Best (Home's vote and age
 * signal) and Top (net score within the window) rank the Realm's newest
 * `cohort` threads. A vote that reorders the ranking between pages makes the
 * next page restart, as Home does.
 */
export async function readRealmThreads(session: WorkReadSession, realm: string,
  query: { sort?: Sort; window?: Window; cursor?: string; limit?: number; now?: number }) {
  await readRealmBasis(session, realm);
  const threads = store(session);
  const sort = query.sort ?? 'best', window = query.window ?? 'week';
  const limit = query.limit ?? REALM_THREAD_COST.pageSize;
  const binding = ['realm-threads-v1', realm, sort, sort === 'top' ? window : null];
  const cursor = decodeReadCursor(query.cursor, binding, session.position);
  const order = cursor?.order.split(':');
  if (sort === 'new' && order && (order.length !== 2 || !order.every(value => /^\d+$/.test(value)))
    || sort !== 'new' && cursor && !/^\d+$/.test(cursor.order)) throw new WorkReadInvalid('Thread cursor is invalid');
  const epochs = await readEpochOrder(session);
  const size = sort === 'new' ? limit + 1 : REALM_THREAD_COST.cohort + 1;
  const rows = (await session.query(`SELECT DISTINCT ?id ?reply ?work ?author ?revision ?review ?preparation
    ?rootRevision ?revisionEpoch ?sequence ?epochOrder WHERE {
    ${epochs} ${headPattern(realm)}
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?id rv:parentReply ?parent } }
    ${sort === 'new' && cursor && order ? `FILTER(?epochOrder > ${order[0]} || (?epochOrder = ${order[0]}
      && (?sequence < ${order[1]} || (?sequence = ${order[1]} && STR(?id) > ${lit(cursor.after)}))))` : ''}
  } ORDER BY ?epochOrder DESC(?sequence) STR(?id) LIMIT ${size}`, size)).map(head);
  if (new Set(rows.map(row => row.placement)).size !== rows.length) {
    throw new WorkReadUnavailable('Realm thread candidates are ambiguous');
  }
  const candidates = rows.slice(0, size - 1);
  const admitted = await threads.admitted(realm, candidates);
  const visible = candidates.filter(row => admitted.has(row.reply));
  let page: Head[], next: string | null = null, votes: Map<string, ThreadVote>;
  if (sort === 'new') {
    page = visible;
    votes = await threads.votes(session.position.dataEpoch, page.map(row => row.placement), reader(session));
    const last = candidates.at(-1);
    if (rows.length > limit && last) {
      next = encodeReadCursor(binding, session.position, last.placement, `${last.epochOrder}:${last.sequence}`);
    }
  } else {
    votes = await threads.votes(session.position.dataEpoch, visible.map(row => row.placement), reader(session));
    const now = query.now ?? Date.now();
    const order = ranked(visible.filter(row => sort !== 'top' || now - row.time.getTime() <= WINDOW_MS[window]),
      sort, row => votes.get(row.placement)?.score ?? 0);
    const offset = cursor ? Number(cursor.order) : 0;
    if (cursor && order[offset - 1]?.placement !== cursor.after) throw new WorkReadMoved('Thread ranking changed');
    page = order.slice(offset, offset + limit);
    if (order.length > offset + limit) {
      next = encodeReadCursor(binding, session.position, page.at(-1)!.placement, String(offset + limit));
    }
  }
  const [texts, titles, named, counted] = await Promise.all([bodies(session, page),
    works(session, page.map(row => row.work)), authors(session, page.map(row => row.author)),
    threads.counts(realm, page.map(row => row.reply))]);
  const items: Summary[] = page.flatMap(row => {
    const text = texts.get(row.reply), about = titles.get(row.work);
    if (!text || !about) return [];
    return [{ reply: row.reply, placement: row.placement, work: about, author: named(row.author),
      time: row.time.toISOString(), language: text.language,
      excerpt: Array.from(text.body.trim()).slice(0, REALM_THREAD_COST.excerptChars).join(''),
      vote: votes.get(row.placement) ?? closed,
      replies: { value: counted.counts.get(row.reply) ?? 0, kind: counted.complete ? 'exact' : 'lower-bound' } }];
  });
  await readRealmBasis(session, realm);
  return { profile: 'realm-threads-v1' as const, realm, sort, window, ...pageResult(session, items, next) };
}

/**
 * A reply and the replies under it in one Realm, with its visible parents for
 * context. A reply shows only while its current placement, exact revision and
 * Realm review hold; one that does not hides the replies beneath it too.
 */
export async function readRealmThread(session: WorkReadSession, realm: string, focus: string, sort: Sort = 'best'):
  Promise<Static<typeof realmThread>> {
  await readRealmBasis(session, realm);
  const threads = store(session);
  const [subtree, parents] = await Promise.all([threads.subtree(focus), threads.ancestors(focus)]);
  if (!subtree.length || subtree[0]!.reply !== focus) throw new WorkReadMissing('Reply is unavailable');
  const complete = subtree.length <= REALM_THREAD_COST.replies + 1;
  const nodes = [...parents, ...subtree.slice(0, REALM_THREAD_COST.replies + 1)];
  const byReply = new Map(nodes.map(item => [item.reply, item]));
  const rows = (await session.query(`SELECT ?id ?reply ?work ?author ?revision ?review ?preparation ?rootRevision
    ?sequence ?parent WHERE {
    VALUES (?slot ?reply) { ${nodes.map(item => `(${iri(replySlotIri(realm, item.reply))} ${iri(item.reply)})`)
      .join(' ')} }
    ${headPattern(realm)}
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?id rv:parentReply ?parent } }
  }`, nodes.length + 1)).map(head);
  if (new Set(rows.map(row => row.reply)).size !== rows.length) {
    throw new WorkReadUnavailable('Reply slot has multiple heads');
  }
  const admitted = await threads.admitted(realm, rows);
  const focused = rows.find(row => row.reply === focus);
  const work = focused?.work;
  // Graph and Content must agree on the reply's place; the whole thread is about one Work.
  const placed = new Map(rows.filter(row => {
    const identity = byReply.get(row.reply);
    return identity && admitted.has(row.reply) && row.parent === identity.parent && row.work === work
      && identity.rootTarget === work;
  }).map(row => [row.reply, row]));
  if (!focused || !placed.has(focus)) throw new WorkReadMissing('Reply is unavailable');
  // Parents stop at the first one that is not shown; replies show only under shown replies.
  const above: Head[] = [];
  for (const parent of parents) {
    const row = placed.get(parent.reply);
    if (!row) break;
    above.unshift(row);
  }
  const shown = new Set([focus]);
  const below: Head[] = [placed.get(focus)!];
  for (const item of subtree.slice(1, REALM_THREAD_COST.replies + 1)) {
    const row = placed.get(item.reply);
    if (row && item.parent && shown.has(item.parent)) { shown.add(item.reply); below.push(row); }
  }
  const all = [...above, ...below];
  const [texts, titles, named, votes] = await Promise.all([bodies(session, all), works(session, [focused.work]),
    authors(session, all.map(row => row.author)),
    threads.votes(session.position.dataEpoch, all.map(row => row.placement), reader(session))]);
  const about = titles.get(focused.work);
  if (!about || !texts.has(focus)) throw new WorkReadMissing('Reply is unavailable');
  const reply = (row: Head): Reply[] => {
    const text = texts.get(row.reply);
    return text ? [{ reply: row.reply, placement: row.placement, parent: row.parent, author: named(row.author),
      time: row.time.toISOString(), language: text.language, revisionId: row.revisionId,
      body: Array.from(text.body).slice(0, REALM_THREAD_COST.bodyChars).join(''),
      vote: votes.get(row.placement) ?? closed }] : [];
  };
  // Depth first, each reply's replies in the chosen order. A reply whose body
  // is gone takes its replies with it, as a hidden placement does.
  const children = new Map<string, Head[]>();
  for (const row of below.slice(1)) children.set(row.parent!, [...children.get(row.parent!) ?? [], row]);
  const items: Reply[] = [];
  const visit = (row: Head) => {
    const shownReply = reply(row);
    if (!shownReply.length) return;
    items.push(...shownReply);
    for (const child of ranked(children.get(row.reply) ?? [], sort, item => votes.get(item.placement)?.score ?? 0)) {
      visit(child);
    }
  };
  visit(below[0]!);
  const ancestors: Reply[] = [];
  for (const row of [...above].reverse()) {
    const shownReply = reply(row);
    if (!shownReply.length) break;
    ancestors.unshift(...shownReply);
  }
  await readRealmBasis(session, realm);
  return { profile: 'realm-thread-v1', realm, thread: ancestors[0]?.reply ?? focus, focus, sort, work: about,
    rootRevision: focused.rootRevision, ancestors, items, complete, sourcePosition: session.position };
}

