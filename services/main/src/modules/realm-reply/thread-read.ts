import type { Static } from 'typebox';
import { readEpochOrder } from '../discovery/lineage.ts';
import { activityTime } from '../feed/ranking.ts';
import { readAgent, readAgentCards } from '../profiles/read.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { GRAPHS, hash, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadMissing,
  WorkReadMoved, WorkReadExpired, WorkReadUnavailable, WorkReadLimit, type ReadRow, type WorkReadSession } from '../work/read-session.ts';
import { clip, discussionParts } from './discussion-text.ts';
import { replySlotIri } from './graph.ts';
import { REALM_ABOUT_THREAD_COST, REALM_THREAD_COST, type realmAboutThread, type realmThread, type realmThreadContinuation, type realmThreadReply, type realmThreadSummary,
  type threadSort, type threadWindow } from './thread-contract.ts';
import type { PlacedHead, RealmReplyThreadStore, ThreadSiblingKey, ThreadVote } from './thread-store.ts';
import { resolveVisibleTargets, resolveSummarizedTargets, targetSummaries, TARGET_RESOLVE_COST } from '../target/resolve.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import { hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import { retainedDocumentBody } from '../../../../content/src/document-body.ts';
import { realmHistoryOriginFilter } from '../realm-admin/history.ts';
import { RealmRankingsIncomplete, type RealmRankKey, type RealmRankPage } from '../rankings/realm-threads.ts';
import { retainedMembershipBasis } from '../read-basis/membership.ts';
import type { ExactReadResult } from '../../../../content/src/core.ts';
import { readBoard } from './boards.ts';

type Sort = Static<typeof threadSort>;
type Window = Static<typeof threadWindow>;
type Summary = Static<typeof realmThreadSummary>;
type Reply = Static<typeof realmThreadReply>;

const revisionPrefix = 'urn:rezics:content:revision:';
const reviewPrefix = 'urn:rezics:realm-review:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const closed: ThreadVote = { score: 0, value: 0, revision: null, open: false };

/** Owner maps and sets must keep their selected entries in the session token;
 * JSON's default empty-object encoding would silently lose their fences. */
function selectedOwnerValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return [...value].sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([key, item]) => [key, selectedOwnerValue(item)]);
  if (value instanceof Set) return [...value].map(selectedOwnerValue)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (Array.isArray(value)) return value.map(selectedOwnerValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, selectedOwnerValue(item)]));
  return value;
}

async function selectedOwnerRead<T>(session: WorkReadSession, key: readonly unknown[], read: () => Promise<T>,
  selected: (value: T) => unknown = selectedOwnerValue): Promise<T> {
  const value = await read();
  // Lightweight unit adapters lack the session owner; production sessions
  // register each bounded selected value and close its reread before delivery.
  session.observeDependency?.(`realm-thread:${hash(JSON.stringify(key))}`, selected(value),
    async () => selected(await read()));
  return value;
}

function selectedContent(results: readonly ExactReadResult[]) {
  return results.map(result => {
    if (result.status !== 'available') return { revisionId: result.revisionId, status: result.status };
    const ref = result.reference;
    return { revisionId: result.revisionId, status: result.status,
      reference: { owner: ref.owner, resourceId: ref.resourceId, variantId: ref.variantId,
        revisionId: ref.revisionId, model: ref.model, byteDigest: ref.byteDigest, byteLength: ref.byteLength,
        language: ref.language, direction: ref.direction, sourceRevision: ref.sourceRevision,
        predecessor: ref.predecessor, provenance: ref.provenance }, body: result.body };
  });
}

/** Find the owner's one discussion without enumerating threads or reading bodies.
 * The nullable placement and approval probes run even for an absent/reserved
 * key. Closing owner probes suppress stale approval, history and disclosure. */
export async function readRealmAboutThread(session: WorkReadSession, realm: string, about: string):
  Promise<Static<typeof realmAboutThread>> {
  const basis = await readRealmBasis(session, realm);
  const threads = store(session);
  const ownerRead = async <T>(read: () => Promise<T>): Promise<T> => {
    try { return await read(); }
    catch (error) { throw new WorkReadUnavailable('About thread owner is unavailable', { cause: error }); }
  };
  const canonical = await selectedOwnerRead(session, ['about-thread', realm, about],
    () => ownerRead(() => threads.aboutThread(realm, about)));
  const history = async () => basis.visibility === 'private' && basis.history === 'from-admission'
    ? realmHistoryOriginFilter(session, realm, 'placement', '?slot') : '';
  const openingHistory = await history();
  // A non-resource sentinel cannot collide with an existing reply. The same
  // exact slot-shaped query returns a neutral row when no opener is placed.
  const reply = canonical?.openerReply ?? 'urn:rezics:realm-about-thread:absent';
  const rows = await session.query(`SELECT ?id ?reply ?slotRealm ?slotWork ?slotReply ?work ?author ?revision
    ?review ?preparation ?rootRevision ?sequence ?parent ?eligible WHERE {
    VALUES ?slot { ${iri(replySlotIri(realm, reply))} }
    OPTIONAL {
      GRAPH ${iri(GRAPHS.current)} { ?slot rv:replyPlacementHead ?id .
        OPTIONAL { ?slot rv:realm ?slotRealm }
        OPTIONAL { ?slot rv:reply ?slotReply }
        OPTIONAL { ?slot rv:rootTarget ?slotWork }
      }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
        ?id a rv:RealmReplyPlacement ; rv:realm ${iri(realm)} ; rv:reply ?reply ; rv:rootTarget ?work ;
          rv:rootRevision ?rootRevision ; rv:author ?author ; rv:contentRevision ?revision ;
          rv:reviewDecision ?review ; rv:contentPreparation ?preparation ; rv:sequence ?sequence .
      } }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?id rv:parentReply ?parent } }
      BIND(EXISTS { ${headPattern(realm)} ${openingHistory} } AS ?eligible)
    }
  } LIMIT 2`, 2);
  if (rows.length !== 1) throw new WorkReadUnavailable('About reply slot has ambiguous cardinality');
  const row = rows[0]!;
  const raw = row.id ? head(row) : null;
  if (!raw && ['work', 'author', 'revision', 'review', 'preparation', 'rootRevision', 'sequence', 'parent']
    .some(key => row[key])) throw new WorkReadUnavailable('About reply placement is malformed');
  if (raw && (!canonical || raw.reply !== canonical.openerReply || raw.work !== about
    || raw.rootRevision !== canonical.rootRevision || raw.parent !== null
    || row.slotRealm?.value !== realm || row.slotWork?.value !== about || row.slotReply?.value !== reply
    || !['true', 'false'].includes(row.eligible?.value ?? ''))) {
    throw new WorkReadUnavailable('About reply placement disagrees with the canonical key');
  }
  const placed = row.eligible?.value === 'true' ? raw : null;
  const identity = await ownerRead(() => threads.aboutPlacement(realm, placed));
  const targets = await resolveVisibleTargets(session, [about], 'discussion');
  const disclosure = () => discloseInventory(session.deps.environment, [
    { owner: 'content', resource: reply, component: 'body', revision: placed?.revisionId ?? null,
      work: about, context: realm },
    { owner: 'graph', resource: realm, component: 'record', context: realm },
  ], disclosureViewer(session.principal), 'thread');
  const visible = (decisions: Awaited<ReturnType<typeof disclosure>>) => {
    if (decisions.length !== 2 || decisions.some(value => !['visible', 'hidden', 'tombstone'].includes(value))) {
      throw new WorkReadUnavailable('About thread disclosure is malformed');
    }
    return { thread: decisions[0] === 'visible', realm: decisions[1] === 'visible' };
  };
  const openingVisible = visible(await disclosure());
  const currentIdentity = await ownerRead(() => threads.aboutPlacement(realm, placed));
  const currentTargets = await session.selection(`about-thread-final-target:${about}`,
    probe => resolveVisibleTargets(probe, [about], 'discussion'));
  const closingVisible = visible(await disclosure());
  const closingHistory = await history();
  if (openingHistory !== closingHistory) throw new WorkReadMoved('Realm history changed during the about lookup');
  // Hidden and absent targets use the same complete probe schedule and 404.
  if (!targets.length || !currentTargets.length || !openingVisible.realm || !closingVisible.realm) {
    throw new WorkReadMissing('Resource is unavailable');
  }
  if (targets[0]!.revision !== currentTargets[0]!.revision) {
    throw new WorkReadMoved('Discussion target changed during the about lookup');
  }
  for (const node of [identity, currentIdentity]) {
    if (node && (!placed || node.reply !== placed.reply || node.parent !== null || node.rootTarget !== about
      || node.rootRevision !== placed.rootRevision || node.author !== placed.author)) {
      throw new WorkReadUnavailable('About opener identity disagrees with its placement');
    }
  }
  const response: Static<typeof realmAboutThread> = { realm, about,
    thread: canonical?.state === 'active' && identity && currentIdentity
      && openingVisible.thread && closingVisible.thread
      ? { reply: canonical.openerReply, rootRevision: canonical.rootRevision } : null };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > REALM_ABOUT_THREAD_COST.responseBytes) {
    throw new WorkReadLimit('About thread exceeds the response budget');
  }
  return response;
}

/** A Realm placement head as the graph states it. */
interface Head extends PlacedHead { placement: string; work: string; author: string; rootRevision: string;
  parent: string | null; time: Date; epochOrder: string; sequence: string;
}

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

/** A boolean on the exact revision body, or absent. Anything else is a corrupt declaration, not "safe". */
function declaredSpoiler(body: Record<string, unknown>): boolean | undefined {
  if (!Object.hasOwn(body, 'spoiler') || body.spoiler == null) return undefined;
  if (typeof body.spoiler !== 'boolean') throw new WorkReadUnavailable('Reply spoiler declaration is invalid');
  return body.spoiler;
}

/** Exact placed bodies, in Content's 64-revision batches. Unreadable bodies keep a neutral reply position.
 * The spoiler declaration comes from that body; the closing availability probe stays batched. */
async function bodies(session: WorkReadSession, heads: readonly Head[], realm: string) {
  const targets = heads.map((item) => ({ owner: 'content' as const,
    resource: item.reply, component: 'body' as const, revision: item.revisionId,
    work: item.work, context: realm }));
  const decisions = await selectedOwnerRead(session, ['body-disclosure', realm, targets],
    () => discloseInventory(session.deps.environment, targets, disclosureViewer(session.principal), 'thread'));
  heads = heads.filter((_item, index) => decisions[index] === 'visible');
  const revisions = [...new Set(heads.map((item) => item.revisionId))];
  const read = new Map<string, { body: string; document?: DocumentSnapshot; language: string | null; spoiler?: boolean }>();
  for (let start = 0; start < revisions.length; start += REALM_THREAD_COST.contentBatch) {
    const batch = revisions.slice(start, start + REALM_THREAD_COST.contentBatch);
    const results = await selectedOwnerRead(session, ['content', batch],
      () => session.deps.content!.readExactBatch(batch, async (ids) => new Set(ids)), selectedContent);
    for (const result of results) {
      if (result.status !== 'available' || typeof result.body.body !== 'string') continue;
      const { language } = result.reference;
      const spoiler = declaredSpoiler(result.body);
      read.set(result.revisionId, { ...retainedDocumentBody(result.body),
        ...(spoiler === undefined ? {} : { spoiler }),
        language: language.kind === 'tag' ? language.tag : null });
    }
  }
  return new Map(heads.flatMap((item) => {
    const body = read.get(item.revisionId);
    return body && (body.document ? hasDocumentContent(body.document) : body.body.trim()) ? [[item.reply, body] as const] : [];
  }));
}

/** At most one authority/summary batch and one resolver batch per 64 distinct
 * roots on the page. Hidden roots cannot suppress otherwise readable threads. */
async function works(session: WorkReadSession, heads: readonly Head[]) {
  const unique = [...new Set(heads.map((head) => head.work))];
  const read = async () => {
  const titles = new Map<string, { id: string; title: Static<typeof import('../work/read-contract.ts').readName>;
    cover: Static<typeof import('../work/read-contract.ts').readAvatar>;
    }>();
  for (let start = 0; start < unique.length; start += TARGET_RESOLVE_COST.batch) {
    const batch = unique.slice(start, start + TARGET_RESOLVE_COST.batch);
    const result = await targetSummaries(session, batch);
    if (session.fencesSelectedUnits
      ? !result.generation.graph.startsWith(`${session.position.dataEpoch}:`)
      : result.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) {
      throw new WorkReadMoved('Thread roots changed');
    }
    const available = result.summaries.filter(
      (summary) => summary.status === 'available' && summary.base !== null);
    if (!available.length) continue;
    await resolveSummarizedTargets(session, { ...result, summaries: available }, 'discussion', false);
    for (const summary of available) {
      if (summary.status === 'available') titles.set(summary.reference,
        { id: summary.reference, title: summary.name, cover: summary.avatar });
    }
  }
  return titles;
  };
  return session.retained ? session.retained(`thread-roots:${JSON.stringify(unique)}`, read) : read();
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

/** Whether the graph holds no placement head in this Realm at all. */
async function realmHasNoThreads(session: WorkReadSession, realm: string): Promise<boolean> {
  return (await session.query(`SELECT ?id WHERE { ${headPattern(realm)} } LIMIT 1`, 1)).length === 0;
}

/**
 * One page of a Realm's discussions: replies placed in the Realm that answer
 * no other reply. New follows placement order; Best (Home's vote and age
 * signal) and Top (net score within the rolling window) seek the complete
 * maintained Realm population. Population changes restart continuations;
 * votes keep their keyset position. Only the selected page crosses live disclosure.
 */
export async function readRealmThreads(session: WorkReadSession, realm: string,
  query: { sort?: Sort; window?: Window; cursor?: string; limit?: number; now?: number; concept?: string }) {
  const basis = await readRealmBasis(session, realm);
  if (query.concept) await readBoard(session, realm, query.concept);
  const threads = store(session);
  const sort = query.sort ?? 'best', window = query.window ?? 'week';
  let population: string | undefined;
  const maintained = sort !== 'new' || !!query.concept;
  if (maintained && basis.visibility === 'private') {
    const policy = await session.realm(realm);
    if (policy.history === 'from-admission') {
      if (
        !session.principal ||
        !session.options.actingSubject ||
        !session.deps.access.realmHistoryFloor
      ) {
        throw new WorkReadUnavailable('Realm history admission is unavailable');
      }
      const floor = await session.deps.access.realmHistoryFloor(
        session.principal,
        session.options.actingSubject,
        realm,
      );
      if (floor)
        population = await threads.historyPopulation(session.position.dataEpoch, realm, floor);
    }
  }
  const history =
    !maintained && basis.visibility === 'private' && basis.history === 'from-admission'
      ? await realmHistoryOriginFilter(session, realm, 'placement', '?slot') : '';
  const limit = query.limit ?? REALM_THREAD_COST.pageSize;
  const binding = ['realm-threads-v1', realm, sort, sort === 'top' ? window : null,
    ...(query.concept ? [{ concept: query.concept }] : []),
    ...(population ? [population] : []),
    ...(session.principal ? [{ issuer: session.principal.issuer, subject: session.principal.subject,
      actingSubject: session.options.actingSubject }] : []),
  ];
  const retained = retainedMembershipBasis('realm-threads-v1', query.cursor, binding, session.position);
  const { cursor } = retained;
  const order = !maintained ? cursor?.order.split(':') : undefined;
  if (order && (order.length !== 4 || !order.slice(0, 3).every((value) => /^\d+$/.test(value))
    || !/^[0-9a-f]{64}$/.test(order[3]!))) {
    throw new WorkReadInvalid('Thread cursor is invalid');
  }
  // New adds two exact-key Access revision probes, independent of Realm size.
  // Its private admission filter is also membership, never a retained grant.
  const newRevision = !maintained ? await threads.rankingRevision(session.position.dataEpoch, realm) : null;
  if (newRevision === 'unavailable') throw new WorkReadUnavailable('Thread population is unavailable');
  // A continuation retains its old membership. Retrying that same cursor
  // cannot repair a changed population; the reader must restart the list.
  if (order && order[2] !== newRevision) throw new WorkReadExpired('Thread population changed');
  if (order && order[3] !== hash(history)) throw new WorkReadExpired('Thread history admission changed');
  let after: (RealmRankKey & { revision: string }) | undefined;
  if (maintained && cursor) {
    try {
      const key = JSON.parse(cursor.order) as { rank: number; time: string; revision: string };
      if (!Number.isFinite(key.rank) || !/^-?\d+$/.test(key.time) || !/^\d+$/.test(key.revision))
        throw new Error('cursor');
      after = { ...key, placement: cursor.after };
    } catch {
      throw new WorkReadInvalid('Thread cursor is invalid');
    }
  }
  let rankedPage: RealmRankPage | null = null;
  if (maintained) {
    try { rankedPage = await selectedOwnerRead(session, ['ranked-page', realm, sort, window, limit, after, population, query.concept],
      () => threads.rankedPage(session, realm, sort, window, limit, after, population, query.concept)); }
    catch (error) {
      // A Realm with no placed reply is empty under every order, so a ranking
      // that has not caught up with a just-created Realm has nothing to hold back.
      if (!(error instanceof RealmRankingsIncomplete) || cursor || !await realmHasNoThreads(session, realm)) throw error;
      retained.assertLive();
      return { profile: 'realm-threads-v1' as const, realm, sort, window, ...pageResult(session, [], null) };
    }
  }
  const selected = rankedPage?.rows.slice(0, limit);
  const epochs = !maintained ? await readEpochOrder(session) : '';
  const size = limit + 1;
  const rows = (await session.query(`SELECT DISTINCT ?id ?reply ?work ?author ?revision ?review ?preparation
    ?rootRevision ?revisionEpoch ?sequence ?epochOrder WHERE {
    ${selected ? `VALUES (?slot ?id) { ${selected.map((row) => `(${iri(replySlotIri(realm, row.reply))} ${iri(row.placement)})`).join(' ')} }` : ''}
    ${epochs} ${headPattern(realm)} ${history}
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?id rv:parentReply ?parent } }
    ${!maintained && cursor && order ? `FILTER(?epochOrder > ${order[0]} || (?epochOrder = ${order[0]}
      && (?sequence < ${order[1]} || (?sequence = ${order[1]} && STR(?id) > ${lit(cursor.after)}))))` : ''}
  } ${!maintained ? 'ORDER BY ?epochOrder DESC(?sequence) STR(?id)' : ''} LIMIT ${size}`, size)).map(head);
  if (new Set(rows.map((row) => row.placement)).size !== rows.length) {
    throw new WorkReadUnavailable('Realm thread candidates are ambiguous');
  }
  const candidates = selected
    ? selected
        .map((item) => rows.find((row) => row.placement === item.placement))
        .filter((row): row is Head => !!row)
    : rows.slice(0, limit);
  const admitted = await selectedOwnerRead(session, ['admitted', realm, candidates],
    () => threads.admitted(realm, candidates));
  const visible = candidates.filter((row) => admitted.has(row.reply));
  let page: Head[], next: string | null = null, votes: Map<string, ThreadVote>;
  if (!maintained) {
    page = visible;
    votes = await selectedOwnerRead(session, ['votes', page.map(row => row.placement)],
      () => threads.votes(session.position.dataEpoch, page.map((row) => row.placement), reader(session)));
    const last = candidates.at(-1);
    if (rows.length > limit && last) {
      next = retained.encode(last.placement, `${last.epochOrder}:${last.sequence}:${newRevision}:${hash(history)}`);
    }
  } else {
    page = visible;
    votes = await selectedOwnerRead(session, ['votes', page.map(row => row.placement)],
      () => threads.votes(session.position.dataEpoch, page.map((row) => row.placement), reader(session)));
    const last = selected!.at(- 1);
    if (rankedPage!.rows.length > limit && last) {
      next = retained.encode(last.placement,
        JSON.stringify({
          rank: last.rank_key,
          time: last.time_key,
          revision: rankedPage!.revision,
        }));
    }
  }
  const historyAdmission = population
    ? (replies: readonly string[]) =>
      threads.rankedHistoryAdmission(session.position.dataEpoch, realm, population!, replies)
    : history ? async (replies: readonly string[]) => {
      if (!replies.length) return new Set<string>();
      const rows = await session.query(`SELECT DISTINCT ?reply WHERE {
        VALUES (?slot ?reply) { ${replies.map((reply) => `(${iri(replySlotIri(realm,reply))} ${iri(reply)})`).join(' ')} }
        ${headPattern(realm)} ${history}
      } LIMIT ${replies.length + 1}`, replies.length);
      return new Set(rows.map((row) => row.reply!.value));
    } : undefined;
  const [texts, titles, named, counted] = await Promise.all([bodies(session, page, realm),
    works(session, page), authors(session, page.map((row) => row.author)),
    selectedOwnerRead(session, ['counts', realm, page.map(row => row.reply), population, history],
      () => threads.counts(realm, page.map((row) => row.reply), historyAdmission))]);
  const items: Summary[] = page.flatMap((row) => {
    const text = texts.get(row.reply), about = titles.get(row.work);
    if (!about || !text) return [];
    const { title, body } = discussionParts(text.body);
    return [{ reply: row.reply, placement: row.placement, work: about, author: named(row.author),
      time: row.time.toISOString(), language: text.language, title,
      excerpt: clip(body, REALM_THREAD_COST.excerptChars),
      ...(typeof text.spoiler === 'boolean' ? { spoiler: text.spoiler } : {}),
      vote: votes.get(row.placement) ?? closed,
      replies: { value: counted.counts.get(row.reply) ?? 0, kind: counted.complete ? 'exact' : 'lower-bound' } }];
  });
  // Opening basis already admitted the Realm. The closing graph position and
  // private membership fence reject a move during hydration; a second policy
  // query would only repeat that check.
  const currentTargets = await works(session, page);
  if (
    (await threads.rankingRevision(session.position.dataEpoch, realm)) !== (rankedPage?.revision ?? newRevision)
  ) {
    throw new WorkReadMoved('Thread ranking changed');
  }
  const readableReplies = new Set(page.filter((row) => currentTargets.has(row.work)).map((row) => row.reply));
  retained.assertLive();
  return { profile: 'realm-threads-v1' as const, realm, sort, window,
    ...pageResult(session, items.filter((item) => readableReplies.has(item.reply)), next) };
}

/**
 * A reply and the replies under it in one Realm, with its visible parents for
 * context. A reply shows only while its current placement, exact revision and
 * Realm review hold; one that does not hides the replies beneath it too.
 */
export async function readRealmThread(session: WorkReadSession, realm: string, focus: string, sort: Sort = 'best', encoded?: string):
  Promise<Static<typeof realmThread>> {
  const basis = await readRealmBasis(session, realm);
  const threads = store(session);
  const history = basis.visibility === 'private' && basis.history === 'from-admission'
    ? await realmHistoryOriginFilter(session, realm, 'placement', '?slot') : '';
  let population: string | undefined;
  if (basis.visibility === 'private' && basis.history === 'from-admission') {
    if (!session.principal || !session.options.actingSubject || !session.deps.access.realmHistoryFloor) {
      throw new WorkReadUnavailable('Realm history admission is unavailable');
    }
    const floor = await session.deps.access.realmHistoryFloor(
      session.principal, session.options.actingSubject, realm,
    );
    if (floor) population = await threads.historyPopulation(session.position.dataEpoch, realm, floor);
  }
  const binding = (parent: string) => ['realm-thread-siblings-v1', realm, parent, sort, hash(history), session.displayLanguages,
    session.principal ? { issuer: session.principal.issuer, subject: session.principal.subject,
      actingSubject: session.options.actingSubject } : null];
  const retained = retainedMembershipBasis('realm-thread-siblings-v1', encoded, binding(focus), session.position);
  const orderRevisions = new Map<string, string>();
  const siblingContinuation = (parent: string, key: ThreadSiblingKey): Static<typeof realmThreadContinuation> =>
    ({ kind: 'siblings', reply: parent, cursor: encodeReadCursor(binding(parent), session.position, key.placement,
      JSON.stringify({ rank: key.rank, time: key.time,
        revision: orderRevisions.get(parent) }), retained.expiresAt) });
  const { cursor } = retained;
  let after: ThreadSiblingKey | undefined;
  let expectedOrderRevision: string | undefined;
  if (cursor) {
    try {
      const key = JSON.parse(cursor.order) as { rank: number; time: string; revision?: string };
      if (!Number.isFinite(key.rank) || !/^-?\d+$/.test(key.time)) throw new Error('cursor');
      if (!uuid.test(key.revision ?? '')) throw new Error('cursor');
      expectedOrderRevision = key.revision;
      after = { ...key, placement: cursor.after };
    } catch { throw new WorkReadInvalid('Thread sibling cursor is invalid'); }
  }
  await threads.assertThreadProjection(session, realm, focus, population);
  const focusBasis = await selectedOwnerRead(session, ['focus', realm, focus],
    () => threads.focusBasis(session.position.dataEpoch, realm, focus));
  if (!focusBasis) throw new WorkReadMissing('Reply is unavailable');
  // A bookmark beneath a withdrawn ancestor still reads its own placed branch.
  // Whole-thread eligibility cannot hide descendants of that new focus; raw
  // candidates remain bounded and pass the same live placement admission below.
  const includeInactive = !focusBasis.active;
  // Breadth-first selection budgets candidates, not only visible replies. Each
  // parent uses a matching index seek; children outside this window keep a route
  // to their own bounded focus read instead of disappearing behind the budget.
  const selected = [focus];
  const selectedKeys = new Map<string, ThreadSiblingKey>();
  const pending = [{ reply: focus, depth: 0, after }];
  const continuations: Static<typeof realmThreadContinuation>[] = [];
  for (let index = 0; index < pending.length; index++) {
    session.checkDeadline();
    const parent = pending[index]!;
    const remaining = REALM_THREAD_COST.replies + 1 - selected.length;
    if (!remaining || parent.depth === REALM_THREAD_COST.depth) {
      continuations.push({ kind: 'depth', reply: parent.reply });
      continue;
    }
    const revision = (await threads.siblingOrderRevisions(session.position.dataEpoch, realm, [parent.reply], sort)).get(parent.reply);
    if (!revision || parent.reply === focus && expectedOrderRevision && revision !== expectedOrderRevision) {
      throw new WorkReadExpired('Sibling order changed; restart this branch');
    }
    orderRevisions.set(parent.reply, revision);
    const page = await selectedOwnerRead(session,
      ['siblings', realm, parent.reply, sort, remaining, parent.after, includeInactive],
      () => threads.siblingPage(session.position.dataEpoch, realm, parent.reply, sort, remaining,
        parent.after, includeInactive));
    const children = page.slice(0, remaining);
    selected.push(...children.map(child => child.reply));
    for (const child of children) {
      selectedKeys.set(child.reply, child);
      if (child.hasChildren) pending.push({ reply: child.reply, depth: parent.depth + 1, after: undefined });
    }
    const last = children.at(-1);
    if (page.length > remaining && last) {
      continuations.push(siblingContinuation(parent.reply, last));
    }
  }
  const [identities, parents] = await Promise.all([
    selectedOwnerRead(session, ['identities', selected], () => threads.identities(selected)),
    selectedOwnerRead(session, ['ancestors', focus], () => threads.ancestors(focus))]);
  const thread = focusBasis.thread;
  const identityMap = new Map(identities.map(node => [node.reply, node]));
  const subtree = selected.flatMap(reply => identityMap.has(reply) ? [identityMap.get(reply)!] : []);
  if (!thread || !subtree.length || subtree[0]!.reply !== focus) throw new WorkReadMissing('Reply is unavailable');
  const nodes = [...parents, ...subtree.slice(0, REALM_THREAD_COST.replies + 1)];
  const byReply = new Map(nodes.map((item) => [item.reply, item]));
  const rows = (await session.query(`SELECT ?id ?reply ?work ?author ?revision ?review ?preparation ?rootRevision
    ?sequence ?parent WHERE {
    VALUES (?slot ?reply) { ${nodes.map((item) => `(${iri(replySlotIri(realm, item.reply))} ${iri(item.reply)})`)
      .join(' ')} }
    ${headPattern(realm)} ${history}
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?id rv:parentReply ?parent } }
  }`, nodes.length + 1)).map(head);
  if (new Set(rows.map((row) => row.reply)).size !== rows.length) {
    throw new WorkReadUnavailable('Reply slot has multiple heads');
  }
  const admitted = await selectedOwnerRead(session, ['admitted', realm, rows], () => threads.admitted(realm, rows));
  const focused = rows.find((row) => row.reply === focus);
  const work = focused?.work;
  // Graph and Content must agree on the reply's place; the whole thread is about one Work.
  const placed = new Map(rows.filter((row) => {
    const identity = byReply.get(row.reply);
    return (
          identity && admitted.has(row.reply) && row.parent === identity.parent && row.work === work
      && identity.rootTarget === work
        );
  }).map((row) => [row.reply, row]));
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
  const [texts, titles, named, votes, blocked] = await Promise.all([bodies(session, all, realm), works(session, [focused]),
    authors(session, all.map((row) => row.author)),
    selectedOwnerRead(session, ['votes', all.map(row => row.placement)],
      () => threads.votes(session.position.dataEpoch, all.map((row) => row.placement), reader(session))),
    blockedAuthors(session, all.map((row) => row.author))]);
  const about = titles.get(focused.work);
  if (!about || !texts.has(focus)) throw new WorkReadMissing('Reply is unavailable');
  // An ancestor's placement alone does not disclose its body identity. Stop
  // context at the first undisclosed parent, just as at an absent placement.
  const visibleAbove: Head[] = [];
  for (const row of [...above].reverse()) {
    if (!texts.has(row.reply)) break;
    visibleAbove.unshift(row);
  }
  const visibleParents = new Set([...visibleAbove, ...below].filter(row => texts.has(row.reply))
    .map(row => row.reply));
  const reply = (row: Head): Reply[] => {
    const text = texts.get(row.reply);
    const { title, body } = !text ? { title: null, body: '' }
      : row.parent ? { title: null, body: text.body.trim() } : discussionParts(text.body);
    const hidden = blocked.has(row.author) || !text;
    return [{ reply: row.reply, placement: row.placement,
      parent: row.parent && visibleParents.has(row.parent) ? row.parent : null,
      author: hidden ? null : named(row.author), blocked: blocked.has(row.author),
      time: row.time.toISOString(), language: text?.language ?? null, revisionId: row.revisionId,
      title: hidden ? null : title,
      body: hidden ? '' : clip(body, REALM_THREAD_COST.bodyChars),
      ...(!hidden && typeof text?.spoiler === 'boolean' ? { spoiler: text.spoiler } : {}),
      ...(!hidden && text?.document ? { document: text.document } : {}),
      vote: hidden ? closed : (votes.get(row.placement) ?? closed),
      }];
  };
  // Depth first, retaining a neutral parent position when its body is restricted.
  const children = new Map<string, Head[]>();
  for (const row of below.slice(1)) children.set(row.parent!, [...(children.get(row.parent!) ?? []), row]);
  const items: Reply[] = [];
  const visit = (row: Head) => {
    const shownReply = reply(row);
    if (!shownReply.length) return;
    items.push(...shownReply);
    for (const child of children.get(row.reply) ?? []) {
      visit(child);
    }
  };
  visit(below[0]!);
  const ancestors: Reply[] = [];
  for (const row of [...visibleAbove].reverse()) {
    const shownReply = reply(row);
    if (!shownReply.length) break;
    ancestors.unshift(...shownReply);
  }
  const oldest = ancestors[0];
  if (oldest && visibleAbove[0]?.parent && ancestors.length === REALM_THREAD_COST.ancestors) {
    continuations.push({ kind: 'ancestors', reply: oldest.reply });
  }
  const reachable = new Set(items.map(item => item.reply));
  const visibleContinuations = continuations.filter(item => item.kind === 'ancestors' || reachable.has(item.reply));
  const blockedNow = await blockedAuthors(session, all.map((row) => row.author));
  if (blockedNow.size !== blocked.size || [...blocked].some((author) => !blockedNow.has(author))) {
    throw new WorkReadMoved('Reader blocks changed during the thread read');
  }
  // Recheck the selected target while the envelope closes its graph and private
  // membership dependencies. The branch projection fence closes after trimming.
  if (!(await works(session, [focused])).has(focused.work)) throw new WorkReadMissing('Thread target is unavailable');
  // The maintained opener is an internal coordinate until this reader has
  // disclosed it. A bounded branch read can instead anchor at a visible reply.
  const visibleThread = visibleParents.has(thread) ? thread : ancestors[0]?.reply ?? focus;
  const response: Static<typeof realmThread> = { profile: 'realm-thread-v1' as const, realm, thread: visibleThread, focus, sort, work: about,
    rootRevision: focused.rootRevision, ancestors, items, continuations: visibleContinuations,
    displayLanguages: session.displayLanguages,
    complete: visibleContinuations.length === 0, sourcePosition: session.position };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > REALM_THREAD_COST.responseBytes) {
    // Large valid bodies must also paginate. Hydration remains the same bounded
    // window; cursor anchors move to the last sibling actually delivered.
    const sizes = new Map([...ancestors, ...items].map(item =>
      [item.reply, Buffer.byteLength(JSON.stringify(item), 'utf8')]));
    const baseBytes = Buffer.byteLength(JSON.stringify({ ...response, items: [], ancestors: [], continuations: [],
      complete: false }), 'utf8');
    const limitedControls = (page: Reply[], above: Reply[]): Static<typeof realmThreadContinuation>[] => {
      const shown = new Set(page.map(item => item.reply));
      const controls = new Map(visibleContinuations.filter(item => item.kind !== 'ancestors' && shown.has(item.reply))
        .map(item => [`${item.kind}:${item.reply}`, item]));
      for (const item of page) {
        const allChildren = children.get(item.reply) ?? [];
        if (!allChildren.some(child => !shown.has(child.reply))) continue;
        controls.delete(`siblings:${item.reply}`);
        controls.delete(`depth:${item.reply}`);
        const last = allChildren.filter(child => shown.has(child.reply)).at(-1);
        const control = last ? siblingContinuation(item.reply, selectedKeys.get(last.reply)!)
          : { kind: 'depth' as const, reply: item.reply };
        controls.set(`${control.kind}:${control.reply}`, control);
      }
      if (above.length < ancestors.length || visibleContinuations.some(item => item.kind === 'ancestors')) {
        const parent = above[0] ?? ancestors.at(-1);
        if (parent) controls.set(`ancestors:${parent.reply}`, { kind: 'ancestors', reply: parent.reply });
      }
      return [...controls.values()];
    };
    const fits = (page: Reply[], above: Reply[]) => {
      const arrayBytes = (rows: Reply[]) => rows.reduce((bytes, item) => bytes + sizes.get(item.reply)!,
        Math.max(0, rows.length - 1));
      return baseBytes + arrayBytes(page) + arrayBytes(above)
        + Buffer.byteLength(JSON.stringify(limitedControls(page, above)), 'utf8') - 2 <= REALM_THREAD_COST.responseBytes;
    };
    // Keep progress before context: the focus and first child fit under Content's
    // per-document admission budget. Otherwise repeated focus reads could stall.
    let page = items.slice(0, 2), above: Reply[] = [];
    if (!fits(page, above)) throw new WorkReadLimit('Thread focus exceeds the response budget');
    for (const parent of [...ancestors].reverse()) {
      const next = [parent, ...above];
      if (!fits(page, next)) break;
      above = next;
    }
    for (const item of items.slice(2)) {
      const next = [...page, item];
      if (!fits(next, above)) break;
      page = next;
    }
    response.items = page;
    response.ancestors = above;
    response.continuations = limitedControls(page, above);
    response.complete = response.continuations.length === 0;
  }
  // Fence after hydration and byte-budget trimming too: a concurrent vote may
  // move an unread sibling before the freshly minted cursor, even on page one.
  if (orderRevisions.size) {
    const current = await threads.siblingOrderRevisions(session.position.dataEpoch, realm, [...orderRevisions.keys()], sort);
    if ([...orderRevisions].some(([parent, revision]) => current.get(parent) !== revision)) {
      throw new WorkReadExpired('Sibling order changed; restart this branch');
    }
  }
  await threads.assertThreadProjection(session, realm, focus, population, nodes.map(node => node.reply));
  retained.assertLive();
  return response;
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
  const nodes = await selectedOwnerRead(session, ['author-page', author, kind, cursor?.order, cursor?.after],
    () => threads.authorPage(author, kind, PROFILE_CONTRIBUTION_COST.candidates,
      cursor ? { time: cursor.order, reply: cursor.after } : undefined));
  const page = nodes.slice(0, PROFILE_CONTRIBUTION_COST.pageSize);
  const items = [];
  const replies = session.deps.realmReplies;
  const disclosed = await selectedOwnerRead(session, ['public-replies', page.map(node => node.reply)],
    () => typeof replies.readPublicBatch === 'function'
    ? replies.readPublicBatch(page.map(node => node.reply),
      session.principal ?? undefined, session.options.actingSubject)
    : Promise.all(page.map(node => replies.readPublic(node.reply,
      session.principal ?? undefined, session.options.actingSubject))));
  if (!(await session.deps.personPreferences?.profileVisible(author, session.principal))) {
    throw new WorkReadMissing('Agent unavailable');
  }
  // At most eight immediate parents, through the same owner authority. Run
  // this after the intermediate profile check so a revoked parent cannot
  // survive that await; close profile privacy after parent hydration too.
  const parentIds = [...new Set(page.flatMap(node => node.parent ? [node.parent] : []))];
  const parents = await selectedOwnerRead(session, ['public-parents', parentIds],
    async () => parentIds.length ? typeof replies.readPublicBatch === 'function'
    ? await replies.readPublicBatch(parentIds, session.principal ?? undefined, session.options.actingSubject)
    : await Promise.all(parentIds.map(parent => replies.readPublic(parent,
      session.principal ?? undefined, session.options.actingSubject))) : []);
  const publicParents = new Set(parentIds.filter((_id, index) => parents[index]));
  for (const [index, node] of page.entries()) {
    if (!node.origin) continue;
    const visible = disclosed[index];
    if (!visible || visible.originRealm !== node.origin || visible.author !== author) continue;
    const parts = node.parent ? { title: null, body: visible.body } : discussionParts(visible.body);
    const spoiler = declaredSpoiler(visible as Record<string, unknown>);
    items.push({ reply: node.reply, realm: node.origin,
      parent: node.parent && publicParents.has(node.parent) ? node.parent : null,
      time: node.createdAt.toISOString(), title: parts.title,
      excerpt: clip(parts.body, PROFILE_CONTRIBUTION_COST.excerptChars),
      ...(spoiler === undefined ? {} : { spoiler }) });
  }
  const last = page.at(-1);
  const next = nodes.length > PROFILE_CONTRIBUTION_COST.pageSize && last
    ? encodeReadCursor(binding, session.position, last.reply, last.createdAt.toISOString()) : null;
  // Parent disclosure is an owner await too: a profile made private during
  // that hydration must not return its contributions under the earlier check.
  if (!(await session.deps.personPreferences?.profileVisible(author, session.principal))) {
    throw new WorkReadMissing('Agent unavailable');
  }
  return { profile: 'agent-realm-contributions-v1' as const, kind,
    ...pageResult(session, items, next) };
}
