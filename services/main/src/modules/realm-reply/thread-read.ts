import type { Static } from 'typebox';
import { readEpochOrder } from '../discovery/lineage.ts';
import { activityTime, bestKey } from '../feed/ranking.ts';
import { readAgent, readAgentCards } from '../profiles/read.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadMissing,
  WorkReadMoved, WorkReadUnavailable, type ReadRow, type WorkReadSession } from '../work/read-session.ts';
import { clip, discussionParts } from './discussion-text.ts';
import { replySlotIri } from './graph.ts';
import { REALM_THREAD_COST, type realmThread, type realmThreadReply, type realmThreadSummary,
  type threadSort, type threadWindow } from './thread-contract.ts';
import type { PlacedHead, RealmReplyThreadStore, ThreadVote } from './thread-store.ts';
import { resolveTargets, targetSummaries, TARGET_RESOLVE_COST } from '../target/resolve.ts';
import { replyRootProof } from './root.ts';

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
// placement whose root revision remains unerased. Target authority is resolved
// after bounded candidate selection, so descriptive types never gate a thread.
const headPattern = (realm: string) => `
  GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmReplySlot ; rv:realm ${iri(realm)} ;
    rv:rootTarget ?work ; rv:reply ?reply ; rv:replyPlacementHead ?id . }
  GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:RealmReplyPlacement ; rv:realm ${iri(realm)} ;
    rv:reply ?reply ; rv:rootTarget ?work ; rv:rootRevision ?rootRevision ; rv:author ?author ;
    rv:contentRevision ?revision ; rv:reviewDecision ?review ; rv:contentPreparation ?preparation ;
    rv:placementOutcome rv:Accepted ; rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence . }
  BIND(IRI(?rootRevision) AS ?rootAnchor)
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?rootAnchor a rv:ErasedRevision } }
  FILTER(EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work ?rootPredicate ?rootValue } }
    || EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?work ?rootPredicate ?rootValue } })`;

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

/** At most one authority/summary batch and one resolver batch per 64 distinct
 * roots on the page. Hidden roots cannot suppress otherwise readable threads. */
const rootKey = (head: Pick<Head, 'work' | 'rootRevision'>) => JSON.stringify([head.work, head.rootRevision]);

async function works(session: WorkReadSession, heads: readonly Head[]) {
  const unique = [...new Set(heads.map(head => head.work))];
  const titles = new Map<string, { id: string; title: Static<typeof import('../work/read-contract.ts').readName>;
    cover: Static<typeof import('../work/read-contract.ts').readAvatar> }>();
  for (let start = 0; start < unique.length; start += TARGET_RESOLVE_COST.batch) {
    const batch = unique.slice(start, start + TARGET_RESOLVE_COST.batch);
    const result = await targetSummaries(session, batch);
    if (result.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) {
      throw new WorkReadMoved('Thread roots changed');
    }
    const available = result.summaries.filter(summary => summary.status === 'available' && summary.base !== null);
    if (!available.length) continue;
    const targets = await resolveTargets(session, available.map(summary => summary.reference), 'discussion');
    const proofs = new Map(targets.map(target => [target.resource, replyRootProof(session, target)]));
    for (const summary of available) {
      if (summary.status !== 'available') continue;
      for (const head of heads.filter(head => head.work === summary.reference)) {
        if (await proofs.get(summary.reference)!(head.work, head.rootRevision)) titles.set(rootKey(head),
          { id: summary.reference, title: summary.name, cover: summary.avatar });
      }
    }
  }
  return titles;
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

/** Check only the bounded authors in this read, using the reader's own block policy. */
async function blockedAuthors(session: WorkReadSession, authors: readonly string[]): Promise<Set<string>> {
  const viewing = reader(session);
  if (!viewing) return new Set();
  const preferences = session.deps.personPreferences;
  if (!preferences) throw new WorkReadUnavailable('Person preferences are unavailable');
  const unique = [...new Set(authors)];
  const blocked = new Set<string>();
  for (let start = 0; start < unique.length; start += 128) {
    for (const actor of await preferences.blockedActors(viewing.principal, viewing.agent,
      unique.slice(start, start + 128))) blocked.add(actor);
  }
  return blocked;
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
    works(session, page), authors(session, page.map(row => row.author)),
    threads.counts(realm, page.map(row => row.reply))]);
  const items: Summary[] = page.flatMap(row => {
    const text = texts.get(row.reply), about = titles.get(rootKey(row));
    if (!text || !about) return [];
    const { title, body } = discussionParts(text.body);
    return [{ reply: row.reply, placement: row.placement, work: about, author: named(row.author),
      time: row.time.toISOString(), language: text.language, title,
      excerpt: clip(body, REALM_THREAD_COST.excerptChars),
      vote: votes.get(row.placement) ?? closed,
      replies: { value: counted.counts.get(row.reply) ?? 0, kind: counted.complete ? 'exact' : 'lower-bound' } }];
  });
  await readRealmBasis(session, realm);
  const currentTargets = await works(session, page);
  const readableReplies = new Set(page.filter(row => currentTargets.has(rootKey(row))).map(row => row.reply));
  return { profile: 'realm-threads-v1' as const, realm, sort, window,
    ...pageResult(session, items.filter(item => readableReplies.has(item.reply)), next) };
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
  const [texts, titles, named, votes, blocked] = await Promise.all([bodies(session, all), works(session, [focused]),
    authors(session, all.map(row => row.author)),
    threads.votes(session.position.dataEpoch, all.map(row => row.placement), reader(session)),
    blockedAuthors(session, all.map(row => row.author))]);
  const about = titles.get(rootKey(focused));
  if (!about || !texts.has(focus)) throw new WorkReadMissing('Reply is unavailable');
  const reply = (row: Head): Reply[] => {
    const text = texts.get(row.reply);
    if (!text) return [];
    const { title, body } = row.parent ? { title: null, body: text.body.trim() } : discussionParts(text.body);
    const hidden = blocked.has(row.author);
    return [{ reply: row.reply, placement: row.placement, parent: row.parent,
      author: hidden ? null : named(row.author), blocked: hidden,
      time: row.time.toISOString(), language: text.language, revisionId: row.revisionId,
      title: hidden ? null : title,
      body: hidden ? '' : clip(body, REALM_THREAD_COST.bodyChars),
      vote: votes.get(row.placement) ?? closed }];
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
  const blockedNow = await blockedAuthors(session, all.map(row => row.author));
  if (blockedNow.size !== blocked.size || [...blocked].some(author => !blockedNow.has(author))) {
    throw new WorkReadMoved('Reader blocks changed during the thread read');
  }
  await readRealmBasis(session, realm);
  if (!(await works(session, [focused])).has(rootKey(focused))) throw new WorkReadMissing('Thread target is unavailable');
  return { profile: 'realm-thread-v1', realm, thread: ancestors[0]?.reply ?? focus, focus, sort, work: about,
    rootRevision: focused.rootRevision, ancestors, items, complete, sourcePosition: session.position };
}

/** Eight newest candidates per page; each exposed entry must still be the current public placement. */
export const PROFILE_CONTRIBUTION_COST = { pageSize: 8, candidates: 9, excerptChars: 400 } as const;

export async function readProfileContributions(session: WorkReadSession, author: string,
  kind: 'posts' | 'comments', encoded?: string, profileGate = readAgent) {
  await profileGate(session, author);
  const threads = store(session);
  if (!session.deps.realmReplies) throw new WorkReadUnavailable('Realm replies are unavailable');
  const binding = ['agent-realm-contributions-v1', author, kind];
  const cursor = decodeReadCursor(encoded, binding, session.position);
  if (cursor && Number.isNaN(Date.parse(cursor.order))) throw new WorkReadInvalid('Contribution cursor is invalid');
  const nodes = await threads.authorPage(author, kind, PROFILE_CONTRIBUTION_COST.candidates,
    cursor ? { time: cursor.order, reply: cursor.after } : undefined);
  const page = nodes.slice(0, PROFILE_CONTRIBUTION_COST.pageSize);
  const items = [];
  for (const node of page) {
    if (!node.origin) continue;
    const visible = await session.deps.realmReplies.readPublic(node.reply,
      session.principal ?? undefined, session.options.actingSubject);
    if (!visible || visible.originRealm !== node.origin || visible.author !== author) continue;
    const parts = node.parent ? { title: null, body: visible.body } : discussionParts(visible.body);
    items.push({ reply: node.reply, realm: node.origin, parent: node.parent,
      time: node.createdAt.toISOString(), title: parts.title,
      excerpt: clip(parts.body, PROFILE_CONTRIBUTION_COST.excerptChars) });
  }
  if (!await session.deps.personPreferences?.profileVisible(author, session.principal)) {
    throw new WorkReadMissing('Agent unavailable');
  }
  const last = page.at(-1);
  const next = nodes.length > PROFILE_CONTRIBUTION_COST.pageSize && last
    ? encodeReadCursor(binding, session.position, last.reply, last.createdAt.toISOString()) : null;
  return { profile: 'agent-realm-contributions-v1' as const, kind,
    ...pageResult(session, items, next) };
}
