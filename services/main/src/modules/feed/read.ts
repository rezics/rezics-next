import { Value } from 'typebox/value';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { followTarget } from '../follows/contract.ts';
import { readFollowTarget } from '../follows/read.ts';
import { readAgentCards, type AgentCard } from '../profiles/read.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadMissing,
  WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { FEED_COST, feedViewerState, type FeedItem, type FeedQuery } from './contract.ts';
import { feedReviewSources, feedSources, type FeedSource } from './source.ts';
import type { FeedRow } from './store.ts';
import type { FeedViewerStateReader } from './viewer-state.ts';
import { feedCardData, feedCardParts, fenceListCard } from './cards.ts';
import { diversityAllows, FEED_RANKING, recommendationAllowed } from './ranking.ts';
import { digest } from '../recommendation/derived-generation.ts';
import type { HomeExclusion } from './personal.ts';
import { direction, languageSatisfies } from '../display-language/select.ts';
import { readWorkKindMatches } from '../onboarding-interests/read.ts';
import { interestKinds, matchingActivityKinds } from '../work/work-kinds.ts';
import type { HomeInterestKind } from '../onboarding-interests/contract.ts';
import { feedWorkPresentations, type FeedWorkPresentation } from './presentation.ts';
import type { Static } from 'typebox';
import { inOrder, settle, unwrap, type Settled } from './settled.ts';
import { clip, discussionParts } from '../realm-reply/discussion-text.ts';
import { feedCompositions } from './compositions.ts';

export interface FeedReader { principal: VerifiedPrincipal; agent: string }
/** Keep the candidate's place without retaining any author, words or image. */
export function feedTombstone(item: FeedItem): FeedItem {
  const actor = { id: item.actor.id, name: '', handle: '' };
  return { ...item, actor, authors: [], reasons: [], post: { title: null, excerpt: null, language: null },
    realm: null, card: { kind: 'activity' }, score: 0, vote: 0, voteRevision: null,
    reason: { kind: 'recommended', basis: 'all' }, viewerState: { status: 'unavailable' },
    group: { key: item.id, count: 1, actors: [actor] }, comments: { value: 0, kind: 'exact' },
    target: { ...item.target, title: { ...item.target.title, value: '', basis: 'fallback' },
      cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: item.id, resourceType: 'work' },
      types: [], excerpt: null, language: null }, primaryAction: { kind: 'open', href: '#' },
    links: { target: '#', actor: '#', comments: '#', vote: '#' } };
}
/** Graph calls left (of 160) below which reader state waits for the fence. */
const SPECULATIVE_VIEWER_CALLS = 100;


export async function visibleFeedSources(session: WorkReadSession, rows: readonly { id: string; kind: string }[]) {
  const graph = rows.filter(row => row.kind !== 'review').map(row => row.id);
  const reviews = rows.filter(row => row.kind === 'review').map(row => row.id);
  const [activities, reviewSources] = await inOrder(feedSources(session, { ids: graph }),
    feedReviewSources(session, reviews));
  return [...activities, ...reviewSources];
}

/** One pointer batch fences the composition labels and order used by chapter cards. */
async function chapterPointers(session: WorkReadSession, sources: readonly FeedSource[]) {
  const occurrences = [...new Set(sources.flatMap(source => source.occurrence ? [source.occurrence] : []))];
  if (!occurrences.length) return new Map<string, string>();
  const rows = await session.query(`SELECT ?occurrence ?structure ?head WHERE {
    VALUES ?occurrence { ${occurrences.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?occurrence rv:structure ?structure . ?structure rv:structureHead ?head }
  } LIMIT ${occurrences.length + 1}`, occurrences.length + 1);
  if (new Set(rows.map(row => row.occurrence?.value)).size !== rows.length
    || rows.some(row => !row.occurrence || !occurrences.includes(row.occurrence.value)
      || !row.structure || !row.head)) throw new WorkReadMoved('Chapter composition changed');
  return new Map(rows.map(row => [row.occurrence!.value, `${row.structure!.value}\0${row.head!.value}`]));
}

/** A fewer signal keeps one deterministic card in four. Hide and mute remove
 * every matching card. This is applied before grouping and cursor emission. */
export function excludedFeedSource(source: FeedSource, exclusions: readonly HomeExclusion[]): boolean {
  for (const rule of exclusions) {
    const matches = rule.kind === 'activity' && rule.target === source.id
      || rule.kind === 'realm' && rule.target === source.realm
      || rule.kind === 'person' && rule.target === source.actor
      || rule.kind === 'work' && rule.target === source.work
      || rule.kind === 'kind' && rule.target === source.kind;
    if (matches && (rule.strength !== 'fewer'
      || Number.parseInt(digest([source.id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0)) return true;
  }
  return false;
}

async function replyExcerpt(session: WorkReadSession, source: FeedSource) {
  if (!source.reply) return { excerpt: source.excerpt, language: source.language };
  if (!session.deps.realmReplies || !session.deps.content || !source.realm) {
    throw new WorkReadUnavailable('Reply owner is unavailable');
  }
  const current = await session.deps.realmReplies.visible(source.realm, source.reply);
  if (!current || current.placement !== source.id
    || `urn:rezics:content:revision:${current.revisionId}` !== source.contentRevision
    || `urn:rezics:realm-review:${current.reviewDecisionId}` !== source.review) throw new WorkReadMissing('Reply unavailable');
  const body = (await session.deps.content.readExactBatch([current.revisionId], async ids => new Set(ids)))[0];
  if (!body || ['missing', 'erased', 'denied'].includes(body.status)) throw new WorkReadMissing('Reply unavailable');
  if (body.status !== 'available' || body.reference.resourceId !== source.reply || typeof body.body.body !== 'string') {
    throw new WorkReadUnavailable('Reply body unavailable');
  }
  const after = await session.deps.realmReplies.visible(source.realm, source.reply);
  if (!after || after.placement !== current.placement || after.revisionId !== current.revisionId
    || after.reviewDecisionId !== current.reviewDecisionId) throw new WorkReadMissing('Reply unavailable');
  const language = body.reference.language.kind === 'tag' ? body.reference.language.tag : null;
  // A discussion is titled by its first line; a reply is only its words.
  const parts = source.kind === 'discussion' ? discussionParts(body.body.body)
    : { title: null, body: body.body.body.trim() };
  return { excerpt: body.body.body.slice(0, 400), language,
    post: { title: parts.title, excerpt: clip(parts.body, 400) || null, language } };
}

async function replyExcerpts(session: WorkReadSession, sources: readonly FeedSource[]) {
  const replies = sources.filter(source => source.reply && source.realm);
  const bodies = new Map<string, Settled<Awaited<ReturnType<typeof replyExcerpt>>>>();
  if (!replies.length) return { bodies, fence: async () => {} };
  if (!session.deps.realmReplies || !session.deps.content) throw new WorkReadUnavailable('Reply owner is unavailable');
  const heads = await session.deps.realmReplies.visiblePublicBatch(replies.map(source => ({ realm: source.realm!, reply: source.reply! })));
  const exacts = (await Promise.all(Array.from({ length: Math.ceil(heads.length / 4) }, (_, batch) =>
    session.deps.content!.readExactBatch(heads.slice(batch * 4, batch * 4 + 4).map(head => head.revisionId), async ids => new Set(ids))))).flat();
  for (const source of replies) {
    const index = heads.findIndex(head => head.realm === source.realm && head.reply === source.reply && head.placement === source.id
      && `urn:rezics:content:revision:${head.revisionId}` === source.contentRevision
      && `urn:rezics:realm-review:${head.reviewDecisionId}` === source.review);
    const exact = exacts[index];
    if (index < 0 || !exact || ['missing','erased','denied'].includes(exact.status)) {
      bodies.set(source.id, { ok: false, error: new WorkReadMissing('Reply unavailable') }); continue;
    }
    if (exact.status !== 'available' || exact.reference.resourceId !== source.reply || typeof exact.body.body !== 'string')
      throw new WorkReadUnavailable('Reply body unavailable');
    const language = exact.reference.language.kind === 'tag' ? exact.reference.language.tag : null;
    const parts = source.kind === 'discussion' ? discussionParts(exact.body.body) : { title: null, body: exact.body.body.trim() };
    bodies.set(source.id, { ok: true, value: { excerpt: exact.body.body.slice(0,400), language,
      post: { title: parts.title, excerpt: clip(parts.body,400) || null, language } } });
  }
  return { bodies, fence: async () => {
    const approved = await session.deps.realmReplies!.currentFeedApprovals(heads);
    if (approved.size !== heads.length) throw new WorkReadMoved('Reply approval changed');
  } };
}

/**
 * The post's own title and words, now that its card is known. A discussion or
 * reply brings them from its body; a chapter, release or list has its own
 * title; a review has only its opening; anything else is the Work itself.
 */
function postOf(item: FeedItem, reply: FeedItem['post'] | undefined): FeedItem['post'] {
  if (reply) return reply;
  const { card, target } = item;
  const language = target.language;
  if (card.kind === 'chapter') return { title: card.title ?? null, excerpt: card.excerpt ?? null, language };
  if (card.kind === 'release') return { title: card.version ?? null, excerpt: card.changelogExcerpt ?? null, language };
  if (card.kind === 'review') return { title: null, excerpt: card.opening, language };
  if (card.kind === 'list') return { title: target.title.value, excerpt: null, language: target.title.language };
  return { title: null, excerpt: target.excerpt, language };
}

/** Counts only currently approved, visible placements. A global card counts
 * one public Realm thread; if more Realms exist its count is a lower bound.
 * Each owner count probes at most 64 placements, never an unbounded aggregate.
 * One graph batch names each global card's first public Realm thread and
 * whether another exists; each distinct Realm and Work is counted once. */
async function commentCounts(session: WorkReadSession, sources: readonly FeedSource[]) {
  // A discussion or reply counts the replies under it, not every thread on its
  // Work: one bounded Content walk per Realm on the page (realm-reply/thread-store.ts).
  const byRealm = new Map<string, string[]>();
  for (const source of sources) {
    if (source.reply && source.realm) byRealm.set(source.realm, [...byRealm.get(source.realm) ?? [], source.reply]);
  }
  // A composition without the thread owner still reads; its thread cards claim no more than none.
  const threadCounts = new Map([...byRealm].map(([realm, replies]) => [realm, settle(
    session.deps.realmReplyThreads?.counts(realm, [...new Set(replies)])
      ?? Promise.resolve({ counts: new Map<string, number>(), complete: false }))]));
  const global = [...new Set(sources.flatMap(source => source.work && !source.realm ? [source.work] : []))];
  const threads = await settle(global.length ? session.query(`SELECT ?work (MIN(STR(?realm)) AS ?first)
    (MAX(STR(?realm)) AS ?last) WHERE { VALUES ?work { ${global.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmReplySlot ; rv:rootTarget ?work ; rv:realm ?realm .
      ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
      FILTER NOT EXISTS { ?realm rv:protectionHead ?protection } }
  } GROUP BY ?work`, global.length) : Promise.resolve([]));
  const pairs = new Map<string, { realm: string; work: string }>();
  if (!threads.ok) throw threads.error;
  for (const source of sources) {
    if (source.reply || !source.work) continue;
    const realm = source.realm ?? threads.value.find(row => row.work?.value === source.work)?.first?.value;
    if (realm) pairs.set(JSON.stringify([realm,source.work]), { realm, work: source.work });
  }
  const counted = new Map<string, { count: number; complete: boolean }>();
  if (pairs.size) {
    if (!session.deps.realmReplies) throw new WorkReadUnavailable('Comment count owner unavailable');
    const entries = [...pairs];
    const rows = await session.query(`SELECT * WHERE { ${entries.map(([key,pair], index) => `{
      { SELECT ?reply ?placement ?revision ?review ?preparation ?rootRevision WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmReplySlot ; rv:realm ${iri(pair.realm)} ;
          rv:rootTarget ${iri(pair.work)} ; rv:reply ?reply ; rv:replyPlacementHead ?placement .
          ${iri(pair.realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
          ?space a rv:Space ; rv:realmCapability ${iri(pair.realm)} ; rv:disclosure rv:Public .
          FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
          FILTER NOT EXISTS { ${iri(pair.realm)} rv:protectionHead ?protection } }
        GRAPH ${iri(GRAPHS.revisions)} { ?placement a rv:RealmReplyPlacement ; rv:placementOutcome rv:Accepted ;
          rv:realm ${iri(pair.realm)} ; rv:reply ?reply ; rv:rootTarget ${iri(pair.work)} ; rv:rootRevision ?rootRevision ;
          rv:contentRevision ?revision ; rv:reviewDecision ?review ; rv:contentPreparation ?preparation . }
        BIND(IRI(?rootRevision) AS ?rootAnchor)
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?rootAnchor a rv:ErasedRevision } }
      } ORDER BY ?reply LIMIT 65 } BIND("${index}" AS ?pair)
    }`).join(' UNION ')} }`, entries.length * 65);
    const heads = entries.flatMap(([key,pair], index) => {
      const own = rows.filter(row => row.pair?.value === String(index));
      counted.set(key, { count: 0, complete: own.length <= 64 });
      return own.slice(0,64).map(row => ({ ...pair, key, reply: row.reply!.value,
        revisionId: row.revision!.value.replace('urn:rezics:content:revision:', ''),
        reviewDecisionId: row.review!.value.replace('urn:rezics:realm-review:', ''), preparationId: row.preparation!.value }));
    });
    const approved = await session.deps.realmReplies.currentFeedApprovals(heads);
    const decisions = await session.disclosure(heads.map(head => ({ owner: 'content' as const, resource: head.reply,
      component: 'body' as const, revision: head.revisionId, work: head.work, context: head.realm })), 'count');
    heads.forEach((head,index) => { if (approved.has(index) && decisions[index] === 'visible') counted.get(head.key)!.count++; });
  }
  const count = (realm: string, work: string) => Promise.resolve({ ok: true as const,
    value: counted.get(JSON.stringify([realm,work])) ?? { count: 0, complete: true } });
  const results = await Promise.all(sources.map(async (source): Promise<Settled<FeedItem['comments']>> => {
    if (source.reply && source.realm) {
      const counted = await threadCounts.get(source.realm)!;
      return counted.ok ? { ok: true, value: { value: counted.value.counts.get(source.reply) ?? 0,
        kind: counted.value.complete ? 'exact' : 'lower-bound' } } : counted;
    }
    if (!source.work) return { ok: true, value: { value: 0, kind: 'exact' } };
    let realm = source.realm, single = true;
    if (!realm) {
      if (!threads.ok) return threads;
      const row = threads.value.find(candidate => candidate.work?.value === source.work);
      if (!row?.first) return { ok: true, value: { value: 0, kind: 'exact' } };
      realm = row.first.value; single = row.first.value === row.last?.value;
    }
    const counted = await count(realm, source.work);
    return { ok: true, value: { value: counted.value.count,
      kind: counted.value.complete && single ? 'exact' : 'lower-bound' } };
  }));
  return new Map(sources.map((source, index) => [source.id, results[index]!]));
}

type FollowTarget = Static<typeof followTarget>;
function summaryTargets(ids: readonly string[], kind: 'work' | 'realm', summaries: ReadonlyMap<string, import('../media/summary.ts').ResourceSummary>) {
  const result = new Map<string, FollowTarget>();
  for (const id of new Set(ids)) {
    const summary = summaries.get(id);
    if (summary?.status === 'available' && summary.disclosure === 'public' && summary.type === kind)
      result.set(id, { id, kind, name: summary.name, icon: summary.avatar,
        realm: kind === 'realm' ? id : null, href: kind === 'work' ? `/w/${id.slice(-36)}` : `/r/${id.slice(-36)}` });
  }
  return result;
}
const workEvent = (kind: FeedSource['kind']) => kind === 'work' || kind === 'added' || kind === 'adoption';
const targetHref = (source: FeedSource) => source.work ? `/w/${source.work.slice(-36)}` : `/collections/${source.target.slice(-36)}`;
function targetLink(source: FeedSource) {
  const href = targetHref(source);
  return source.readerReview ? `${href}#review-${source.readerReview.id}`
    : source.reply ? `${href}/discussion#${source.reply.slice(-36)}` : href;
}
function itemTarget(source: FeedSource, target: Pick<FollowTarget, 'name' | 'icon'> | null | undefined,
  presentation: FeedWorkPresentation | undefined, body: { excerpt: string | null; language: string | null }): FeedItem['target'] {
  return { id: source.target, work: source.work,
    title: target?.name ?? { value: source.title ?? '', language: '',
      direction: direction('', source.title ?? ''), basis: 'fallback' },
    cover: target?.icon ?? { kind: 'fallback', policy: 'avatar-fallback-v1', key: source.target, resourceType: 'collection' },
    types: presentation?.types ?? [],
    excerpt: workEvent(source.kind) ? presentation?.excerpt ?? body.excerpt : body.excerpt,
    language: workEvent(source.kind) ? presentation?.language ?? body.language : body.language };
}

/** One card from its hydrated parts; the reads themselves are page batches. */
function feedItem(source: FeedSource, row: FeedRow, actor: AgentCard, target: FollowTarget | null,
  realm: FollowTarget | null, body: { excerpt: string | null; language: string | null; post?: FeedItem['post'] },
  comments: FeedItem['comments'], presentation: FeedWorkPresentation | undefined): FeedItem {
  const href = targetHref(source);
  const reasons: FeedItem['reasons'] = source.kind === 'work' ? [{ kind: 'new-work', actor: source.actor }]
    : source.kind === 'added' ? [{ kind: 'added-to-rezics', actor: source.actor }]
      : source.kind === 'adoption' && source.realm
        ? [{ kind: 'realm-pick', realm: source.realm, curator: source.actor }] : [];
  const itemTargetValue = itemTarget(source, target, presentation, body);
  return { id: source.id, kind: source.kind, post: body.post ?? { title: null, excerpt: itemTargetValue.excerpt,
    language: itemTargetValue.language }, authors: presentation?.authors ?? [], reasons,
    reason: { kind: 'recommended', basis: 'all' }, group: { key: row.group_key, count: 1,
      actors: [{ id: actor.id, name: actor.displayName, handle: actor.handle }] },
    card: { kind: 'activity' }, primaryAction: { kind: 'open', href }, viewerState: { status: 'anonymous' },
    actor: { id: actor.id, name: actor.displayName, handle: actor.handle },
    target: itemTargetValue,
    realm: realm ? { id: realm.id, name: realm.name, icon: realm.icon } : null,
    time: row.occurred_at.toISOString(), timeBasis: row.time_basis, score: row.score,
    vote: row.vote ?? 0, voteRevision: row.vote_revision ?? null, comments,
    links: { target: targetLink(source), actor: actor.links.profile, comments: source.work ? `${href}/discussion` : href,
      vote: `/v1/feed/${source.id.slice(-36)}/vote` } };
}

/** Distinct Work/Realm classification reads run together, each in its own Realm scope. */
async function readTagSets(session: WorkReadSession, language: string | undefined,
  sources: readonly FeedSource[], senses: string[]) {
  const keys = new Map<string, FeedSource>();
  for (const source of sources) if (source.work && !keys.has(tagKey(source))) keys.set(tagKey(source), source);
  return new Map(await Promise.all([...keys].map(async ([key, source]) => {
    const tagSession = new WorkReadSession(session.deps, session.request, { language,
      languages: session.displayLanguages.join(','), limit: 3,
      ...(source.realm ? { scope: 'realm', realm: source.realm } : {}) }, session.position);
    return [key, await settle(readWorkClassifications(tagSession, source.work!, senses)
      .then(tags => tags.items.map(item => item.sense)))] as const;
  })));
}
const tagKey = (source: Pick<FeedSource, 'work' | 'realm'>) => JSON.stringify([source.work, source.realm]);
const reduced = (source: FeedSource, rule: { kind: string; target: string; strength: string }) => rule.strength !== 'fewer'
  || Number.parseInt(digest([source.id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0;

export async function admitFeedVote(session: WorkReadSession, target: string) {
  const kind = (await session.deps.feed?.members(session.position.dataEpoch, [target]))?.[0]?.kind;
  const source = (await visibleFeedSources(session, [{ id: target, kind: kind ?? '' }]))[0];
  if (!source) throw new WorkReadMissing('Feed activity unavailable');
  if (!(await readAgentCards(session, [source.actor])).has(source.actor)) {
    throw new WorkReadMissing('Feed actor unavailable');
  }
  if (source.work) await readFollowTarget(session, source.work, 'work');
  if (source.realm) await readFollowTarget(session, source.realm, 'realm');
  await replyExcerpt(session, source);
  return { actor: source.actor, work: source.work };
}

/** URL grammar is one comma-separated set, with no implicit fallback kind. */
export function parseFeedInterests(value: string | undefined): HomeInterestKind[] {
  if (value === undefined) return [];
  const kinds = value.split(',');
  if (kinds.length > interestKinds.length || new Set(kinds).size !== kinds.length
    || kinds.some(kind => !interestKinds.includes(kind as HomeInterestKind))) {
    throw new WorkReadInvalid('Invalid feed interests');
  }
  return kinds as HomeInterestKind[];
}

export function matchesFeedInterest(source: Pick<FeedSource, 'kind' | 'work'>,
  interests: readonly HomeInterestKind[], workMatches: ReadonlyMap<string, readonly HomeInterestKind[]>): boolean {
  if (!interests.length) return true;
  const activityKinds = matchingActivityKinds(source.kind);
  if (activityKinds.length) return interests.some(kind => activityKinds.includes(kind));
  return !!source.work && interests.some(kind => workMatches.get(source.work!)?.includes(kind));
}

/** Group only disclosed review cards. A later deletion or restriction cannot
 * hide a public sibling behind a private projection anchor. */
export function collapseReviewCards(items: FeedItem[]): FeedItem[] {
  const result: FeedItem[] = [];
  const buckets = new Map<string, Array<{ index: number; works: Set<string> }>>();
  for (const item of items) {
    if (item.kind !== 'review' || !item.target.work) { result.push(item); continue; }
    const key = JSON.stringify([item.actor.id, item.realm?.id ?? null, item.time.slice(0, 13), item.reason]);
    const groups = buckets.get(key) ?? [];
    const group = groups.find(candidate => candidate.works.size < FEED_COST.groupMembers
      && !candidate.works.has(item.target.work!));
    if (group) {
      group.works.add(item.target.work);
      const lead = result[group.index]!;
      lead.group = { ...lead.group, count: lead.group.count + 1 };
      continue;
    }
    item.group = { ...item.group, key: digest(['home-review-group-v1', key, groups.length]) };
    groups.push({ index: result.length, works: new Set([item.target.work]) });
    buckets.set(key, groups);
    result.push(item);
  }
  return result;
}

/** A public Work creation and Realm pick share one card when both survived
 * filters and disclosure on this page. Keep the pick as the visible anchor. */
export function collapseWorkCards(items: FeedItem[]): FeedItem[] {
  const byWork = new Map<string, number>();
  const result: FeedItem[] = [];
  for (const item of items) {
    const work = item.target.work;
    if (!work || !['work', 'added', 'adoption'].includes(item.kind)) { result.push(item); continue; }
    const prior = byWork.get(work);
    if (prior === undefined) { byWork.set(work, result.length); result.push(item); continue; }
    const original = result[prior]!;
    const lead = item.kind === 'adoption' && original.kind !== 'adoption' ? item : original;
    const companion = lead === item ? original : item;
    const reasons = [...lead.reasons, ...companion.reasons];
    lead.reasons = reasons.filter((reason, index) => reasons.findIndex(other =>
      JSON.stringify(other) === JSON.stringify(reason)) === index);
    if (lead.reason.kind !== 'followed' && companion.reason.kind === 'followed') lead.reason = companion.reason;
    result[prior] = lead;
  }
  return result;
}

/** A reader's review or public collection is activity about what they read. */
export function readingActivityVisible(source: Pick<FeedSource, 'kind' | 'actor'>,
  viewer: string | null, hidden: ReadonlySet<string>): boolean {
  return !(['review', 'collection'] as readonly string[]).includes(source.kind)
    || source.actor === viewer || !hidden.has(source.actor);
}
export function personFeedSourceVisible(source: Pick<FeedSource, 'kind' | 'actor'>,
  viewer: string | null, blocked: readonly string[], hidden: ReadonlySet<string>): boolean {
  return !blocked.includes(source.actor) && readingActivityVisible(source, viewer, hidden);
}
export function contentLanguageVisible(language: string | null,
  [explicit, saved]: readonly (readonly string[] | undefined)[]): boolean {
  return (!explicit?.length || languageSatisfies(language, explicit))
    && (!saved?.length || !language || languageSatisfies(language, saved));
}

/** Any-of Concepts, the required page Concept, and exclusions. Home admits at most three of these. */
function pinnedConcepts(query: FeedQuery): string[] {
  return [...new Set([...(query.concepts ?? []), ...(query.requiredConcept ? [query.requiredConcept] : []),
    ...(query.excludedConcepts ?? [])])];
}

/** A match-any page requires its Concept and any addition, and drops an excluded Concept. Any-of stays any-of. */
function carriesPinnedConcepts(query: FeedQuery, senses: readonly string[]): boolean {
  if (query.requiredConcept && !senses.includes(query.requiredConcept)) return false;
  if (query.concepts?.length && !query.concepts.some(concept => senses.includes(concept))) return false;
  return !query.excludedConcepts?.some(concept => senses.includes(concept));
}

const normalized = (query: FeedQuery) => [
  [...(query.kinds ?? [])].sort(), [...new Set((query.contentLanguages ?? []).map(value => value.toLowerCase()))].sort(),
  [...(query.realms ?? [])].sort(), [...(query.concepts ?? [])].sort(), query.language?.toLowerCase() ?? null,
  parseFeedInterests(query.interests).sort(),
  // Absent for every feed that is not an anchored page, so those cursors stay bound as before.
  ...(query.requiredConcept || query.excludedConcepts?.length
    ? [query.requiredConcept ?? null, [...(query.excludedConcepts ?? [])].sort()] : []),
];

/** Reads run in dependent stages and each stage's independent reads run
 * together: first the owner heads, then the page, then one batch per card
 * part, then the disclosure fence, then the closing head checks. Every item
 * still passes its checks in the original order, so a hidden part drops that
 * item and any other failure fails the read exactly as a serial read would. */
export async function readFeed(session: WorkReadSession, query: FeedQuery, reader?: FeedReader) {
  const interests = parseFeedInterests(query.interests);
  if (pinnedConcepts(query).length > 3) throw new WorkReadInvalid('A feed names at most three Concepts');
  const store = session.deps.feed;
  const follows = session.deps.follows;
  if (!store || !follows) throw new WorkReadUnavailable('Feed owner is unavailable');
  const homePersonal = session.deps.homePersonal;
  if (reader && !homePersonal) throw new WorkReadUnavailable('Home preferences are unavailable');
  if (!session.deps.personPreferences) throw new WorkReadUnavailable('Person preferences are unavailable');
  if (query.scope === 'following' && !reader) throw new WorkReadInvalid('Following requires authentication');
  const frame = await store.openFrame(session.position.dataEpoch, reader);
  const personal = frame.personal, checkpoint = frame.checkpoint, personSettings = frame.personSettings;
  // Saved preferences remain distinct from request filters: only the latter
  // exclude a post whose language has not been recorded.
  if (personal) session.readingLanguages = personal.preferences.contentLanguages;
  const scope = query.scope ?? personal?.preferences.tab ?? 'all';
  if (scope === 'following' && !reader) throw new WorkReadInvalid('Following requires authentication');
  // Following needs its inventory before validating a cursor. All gets the
  // same head from its card-match batch; the private preferences already bind
  // the cursor to the principal through the same followPrincipal authority.
  const following = reader && scope === 'following' ? frame.following : null;
  const sort = query.sort ?? personal?.preferences.sort ?? 'best', window = query.window ?? 'all';
  if (scope === 'following' && sort === 'top') throw new WorkReadInvalid('Top is available in All');
  const binding = ['home-feed-v1', FEED_RANKING.version, scope, sort, window, normalized(query),
    personal?.owner ?? null, reader?.agent ?? null,
    personSettings ? digest([personSettings.version, personSettings.blockedPeople]) : null];
  const cursor = decodeReadCursor(query.cursor, binding, session.position);
  let after: { key: string; id: string } | undefined;
  let asOf = Date.now(), followedSeen = 0;
  let recentRealms: (string | null)[] = [];
  if (cursor) {
    let order: { key: string; projection: string; following: string | null; personal: string | null; targetIndex: string | null;
      asOf: number; followedSeen: number; recentRealms: (string | null)[] };
    try {
      order = JSON.parse(cursor.order) as typeof order;
      if (!order || typeof order.key !== 'string' || typeof order.projection !== 'string'
        || (order.personal !== null && typeof order.personal !== 'string')
        || (order.targetIndex !== null && typeof order.targetIndex !== 'string')
        || !Number.isSafeInteger(order.asOf) || !Number.isInteger(order.followedSeen)
        || order.followedSeen < 0 || order.followedSeen > FEED_RANKING.thinFollowing || !Array.isArray(order.recentRealms)
        || order.recentRealms.length > 9 || order.recentRealms.some(id => id !== null && typeof id !== 'string')) throw new Error('cursor');
    } catch { throw new WorkReadInvalid('Invalid feed cursor'); }
    if (order.projection !== checkpoint.revision || order.personal !== (personal?.revision ?? null)
      || (scope === 'following' && (order.following !== following?.revision
        || sort === 'new' && order.targetIndex !== frame.followingIndexRevision))) {
      throw new WorkReadMoved('Feed changed');
    }
    after = { id: cursor.after, key: order.key }; asOf = order.asOf; recentRealms = order.recentRealms; followedSeen = order.followedSeen;
  }
  const conceptFilter = pinnedConcepts(query);
  const limit = Math.min(query.limit ?? FEED_COST.pageSize, conceptFilter.length ? FEED_COST.tagCandidates : FEED_COST.candidates);
  const rows = await store.page(session.position, checkpoint.revision, sort, limit, after,
    reader ? { ...reader, scope } : undefined, window, asOf, query.kinds, frame);
  const page: FeedRow[] = [];
  let members = 0;
  for (const row of rows.slice(0, limit)) {
    if (members + row.group_members.length > FEED_COST.candidates) break;
    page.push(row); members += row.group_members.length;
  }
  const cutoff = window === 'all' ? 0 : asOf - (window === 'week' ? 7 : 30) * 86_400_000;
  const withinWindow = page.filter(row => row.sort_time.getTime() >= cutoff && row.sort_time.getTime() <= asOf);
  const memberRows = await store.members(session.position.dataEpoch, withinWindow.flatMap(row => row.group_members), frame);
  const sources = await visibleFeedSources(session, memberRows);
  const compositionsRead = feedCompositions(session, sources.flatMap(source => source.work ? [source.work]
    : source.kind === 'collection' ? [source.target] : []));
  const repliesRead = replyExcerpts(session, sources);
  const presentationRead = feedWorkPresentations(session, sources.flatMap(source => source.work ? [source.work] : []), { frame, sources });
  const hiddenReading = (await presentationRead, frame.hiddenReadingActors);
  const summaryIds = [...new Set(sources.flatMap(source => [source.work, source.realm].filter((id): id is string => !!id)))];
  const more = rows.length > page.length;
  /** Groups, collapses and selects the disclosed cards. Pure over its input:
   * it assigns only to the group cards it creates. */
  const select = (disclosed: readonly FeedItem[]) => {
    const groups = page.flatMap(row => {
      // The stable voting/group anchor must remain public. Never expose a hidden
      // anchor through a surviving sibling's card, count or timestamp.
      let entries = disclosed.filter(item => row.group_members.includes(item.id));
      if (!entries.length) return [];
      const anchorVisible = entries.some(item => item.id === row.id);
      const followed = entries.filter(item => item.reason.kind === 'followed');
      if (scope === 'following' && followed.length) entries = followed;
      entries.sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
      const latest = entries[0]!;
      const start = entries.filter(item => item.primaryAction.kind === 'read-chapter').sort((a, b) =>
        (a.card.kind === 'chapter' ? a.card.number ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY)
        - (b.card.kind === 'chapter' ? b.card.number ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY))[0];
      const actors = [...new Map(entries.map(item => [item.actor.id, item.actor])).values()].slice(0, 3);
      const chapters = entries.flatMap(item => item.card.kind === 'chapter' && item.card.number !== undefined ? [item.card.number] : []);
      return [{ ...latest, ...(start ? { primaryAction: start.primaryAction } : {}),
        id: anchorVisible ? row.id : latest.id,
        time: anchorVisible ? row.occurred_at.toISOString() : latest.time,
        timeBasis: anchorVisible ? row.time_basis : latest.timeBasis,
        score: anchorVisible ? row.score : 0, vote: anchorVisible ? row.vote : 0,
        voteRevision: anchorVisible ? row.vote_revision : null,
        links: { ...latest.links, vote: anchorVisible ? `/v1/feed/${row.id.slice(-36)}/vote` : '#' },
        group: { key: anchorVisible ? row.group_key : digest(entries.map(item => item.id)), count: entries.length, actors,
          ...(chapters.length === entries.length && new Set(entries.map(item => item.card.kind === 'chapter' ? item.card.parent : null)).size === 1 ? { range: { kind: 'chapters' as const,
            from: Math.min(...chapters), to: Math.max(...chapters) } } : {}) } }];
    });
    const collapsed = collapseReviewCards(collapseWorkCards(groups));
    const seen = Math.min(FEED_RANKING.thinFollowing, followedSeen + collapsed.filter(item => item.reason.kind === 'followed').length);
    // A sparse page is not evidence that Following is thin. Prove it by an
    // empty follow inventory or by exhausting this view's candidate relation.
    const thinKnown = following?.count === 0 || !more;
    const allowRecommendations = scope === 'all' || personal?.preferences.recommendations !== false
      && thinKnown && recommendationAllowed(scope, sort, seen);
    let realms = recentRealms;
    const chosen = collapsed.filter(item => {
      if (scope === 'following' && item.reason.kind !== 'followed' && !allowRecommendations) return false;
      if (sort === 'best' && !diversityAllows(item.realm?.id ?? null, realms)) return false;
      realms = [...realms, item.realm?.id ?? null].slice(-9);
      return true;
    });
    return { chosen, seen, realms };
  };
  const viewerTargets = (chosen: readonly FeedItem[]) => chosen.map(item => ({ activity: item.id, work: item.target.work,
    ...(item.card.kind === 'chapter' ? { occurrence: item.card.occurrence } : {}) }));
  // Reader state depends only on the selected cards' targets, so it starts
  // with the fence from the selection that holds if every card passes. It is
  // read once per distinct target list, and the fenced selection's own targets
  // decide which read is used; a second read happens only if the fence drops a
  // card, so both share the read's graph budget without doubling it.
  const viewerReads = new Map<string, Promise<Settled<Awaited<ReturnType<FeedViewerStateReader['read']>> | undefined>>>();
  const readViewer = (targets: ReturnType<typeof viewerTargets>) => {
    const key = JSON.stringify(targets);
    if (!viewerReads.has(key)) viewerReads.set(key, settle(reader && session.deps.feedViewerState
      ? compositionsRead.then(compositions => session.deps.feedViewerState!.read(reader, targets, session, frame, compositions)) : Promise.resolve(undefined)));
    return viewerReads.get(key)!;
  };
  // At most eight member Works enter one bounded catalogue read. The same
  // type and accepted-Sense relation powers onboarding suggestions.
  const kindsRead = interests.length ? readWorkKindMatches(session, [...new Set(sources
    .filter(source => matchingActivityKinds(source.kind).length === 0)
    .flatMap(source => source.work ? [source.work] : []))]) : Promise.resolve(new Map<string, HomeInterestKind[]>());
  const summariesRead = session.summaries(summaryIds).then(list => new Map(list.map(summary => [summary.reference, summary])));
  const tagRules = personal?.exclusions.filter(rule => rule.kind === 'tag') ?? [];
  // Selection waits only for interest kinds and tag rules, so without them
  // the card parts start alongside the page's presentation batches.
  const candidatesRead = kindsRead.then(async workKinds => {
    const filtered = sources.filter(source => personFeedSourceVisible(source, reader?.agent ?? null,
      personSettings?.blockedPeople ?? [], hiddenReading)
      && !(personal && excludedFeedSource(source, personal.exclusions))
      && !(query.kinds && !query.kinds.includes(source.kind)) && matchesFeedInterest(source, interests, workKinds)
      && !(query.realms && (!source.realm || !query.realms.includes(source.realm))));
    const tagMatches = tagRules.length ? await readTagSets(session, query.language, filtered, tagRules.map(rule => rule.target))
      : new Map<string, Settled<string[]>>();
    return filtered.filter(source => !source.work || !tagRules.length
      || !tagRules.some(rule => unwrap(tagMatches.get(tagKey(source))!).includes(rule.target) && reduced(source, rule)));
  });
  const partsRead = Promise.all([candidatesRead, compositionsRead]).then(async ([candidates, compositions]) => {
    const batch = await presentationRead;
    const types = new Map([...batch.items].map(([work,item]) => [work,item.types]));
    const prepared = await feedCardParts(session,candidates,compositions,types);
    return inOrder(
      presentationRead.then(batch => batch.actors ?? readAgentCards(session, candidates.map(source => source.actor))),
      summariesRead.then(summaries => summaryTargets(candidates.flatMap(source => source.work ? [source.work] : []), 'work', summaries)),
      summariesRead.then(summaries => summaryTargets(candidates.flatMap(source => source.realm ? [source.realm] : []), 'realm', summaries)),
      repliesRead.then(batch => candidates.map(source => batch.bodies.get(source.id)
        ?? { ok: true as const, value: { excerpt: source.excerpt, language: source.language } })),
      commentCounts(session, candidates),
      // A card reads only its target's cover, which the summary batch already holds.
      summariesRead.then(summaries => Promise.all(candidates.map(source => {
          const summary = source.work ? summaries.get(source.work) : undefined;
          const target = summary?.status === 'available' ? { name: summary.name, icon: summary.avatar } : null;
          return settle(feedCardData(session, source, itemTarget(source, target, undefined, source),
            targetLink(source), types, personSettings?.spoilerPolicy === 'show', compositions,prepared));
        }))),
      conceptFilter.length ? readTagSets(session, query.language, candidates, conceptFilter) : new Map<string, Settled<string[]>>(),prepared);
  });
  // A Work's news also answers to follows of the authors its card credits,
  // which the page's presentation batch already holds. All matches too, so a
  // card there leads with the person the reader follows; one bounded read.
  const matchesRead = presentationRead.then(batch => batch.matches ?? null);
  const [initialChapters, workKinds, summaries, presentationBatch, matches, candidates,
    [actors, workTargets, realmTargets, bodies, comments, cards, acceptedTags, cardParts]] = await inOrder(
    chapterPointers(session, sources), kindsRead, summariesRead, presentationRead,
    matchesRead, candidatesRead, partsRead);
  const presentations = presentationBatch.items;
  const items: FeedItem[] = [];
  for (const [index, source] of candidates.entries()) {
    try {
      const actor = actors.get(source.actor);
      const target = source.work ? workTargets.get(source.work) : null;
      const realm = source.realm ? realmTargets.get(source.realm) : null;
      if (!actor || target === undefined || realm === undefined) throw new WorkReadMissing('Feed card part is unavailable');
      const presentation = source.work ? presentations.get(source.work) : undefined;
      const body = unwrap(bodies[index]!);
      const item = feedItem(source, memberRows.find(row => row.id === source.id)!, actor, target, realm,
        body, unwrap(comments.get(source.id)!), presentation);
      Object.assign(item, unwrap(cards[index]!));
      item.post = postOf(item, 'post' in body ? body.post : undefined);
      const followed = matches?.reasons[sources.indexOf(source)]?.[0];
      item.reason = followed ? { kind: 'followed', target: followed.target, targetKind: followed.kind }
        : { kind: 'recommended', basis: scope === 'following' ? 'thin-following' : 'all' };
      if (!contentLanguageVisible(item.post.language,
        [query.contentLanguages, personal?.preferences.contentLanguages])) continue;
      if (conceptFilter.length) {
        if (!source.work) continue;
        const senses = unwrap(acceptedTags.get(tagKey(source))!);
        if (!carriesPinnedConcepts(query, senses)) continue;
      }
      items.push(item);
    } catch (error) { if (!(error instanceof WorkReadMissing)) throw error; }
  }

  // The selection if every hydrated card also passes the fence. It starts
  // early only while the read's graph budget has room for a second read.
  if (reader && (fusekiReadBudget.getStore()?.callsLeft ?? 0) >= SPECULATIVE_VIEWER_CALLS) {
    void readViewer(viewerTargets(select(items).chosen));
  }
  // The disclosure fence repeats every owner gate once. Graph-derived source
  // fields are pinned by the read's graph position, so reply, card and
  // chapter checks run with the source re-read and are then shown to match it.
  const fenceCards = (item: FeedItem) => item.card.kind === 'prompt' || item.card.kind === 'release'
    || item.card.kind === 'review';
  const earlier = new Map(sources.map(source => [source.id, source]));
  const itemSources = items.map(item => earlier.get(item.id)!);
  const [final, targetFence, finalActors, , finalChapters, finalWorkKinds, replyChecks, cardChecks] = await inOrder(
    session.graphSnapshotFenced ? earlier : visibleFeedSources(session, items).then(list => new Map(list.map(source => [source.id, source]))),
    // List cards' preview Works join the page's one final summary batch.
    summariesRead.then(async prior => {
      const missing = [...new Set(items.flatMap(item => item.card.kind === 'list' ? item.card.works.map(work => work.id) : []))]
        .filter(id => !prior.has(id));
      return [...prior.values(), ...await session.summaries(missing)];
    }).then(async list => {
      const fenced = new Map(list.map(summary => [summary.reference, summary]));
      const [works, realms, lists] = await inOrder(
        summaryTargets(items.flatMap(item => item.target.work ? [item.target.work] : []), 'work', fenced),
        summaryTargets(items.flatMap(item => item.realm ? [item.realm.id] : []), 'realm', fenced),
        Promise.all(items.map(item => item.card.kind === 'list' ? settle(fenceListCard(session, item.card, fenced)) : null)));
      return { fenced, works, realms, lists };
    }),
    session.graphSnapshotFenced ? actors : readAgentCards(session, items.map(item => item.actor.id), 'required', frame.actorState),
    presentationBatch.fence(),
    session.graphSnapshotFenced ? initialChapters : chapterPointers(session, itemSources),
    session.graphSnapshotFenced ? workKinds : interests.length ? readWorkKindMatches(session, [...new Set(itemSources
      .filter(source => matchingActivityKinds(source.kind).length === 0)
      .flatMap(source => source.work ? [source.work] : []))]) : new Map<string, HomeInterestKind[]>(),
    repliesRead.then(async batch => { await batch.fence(); return itemSources.map(source => batch.bodies.get(source.id)
      ?? { ok: true as const, value: { excerpt: source.excerpt, language: source.language } }); }),
    compositionsRead.then(compositions => Promise.all(items.map((item, index) => fenceCards(item) && item.kind !== 'review'
      ? settle(feedCardData(session, itemSources[index]!, item.target, item.links.target,
        new Map([...presentations].map(([work,value]) => [work,value.types])), personSettings?.spoilerPolicy === 'show',compositions,cardParts)) : null))));
  const graphFields = (source: FeedSource) => JSON.stringify([source.id, source.kind, source.actor, source.target, source.work,
    source.realm, source.zone, source.language, source.occurrence, source.contentTarget, source.reply,
    source.contentRevision, source.review]);
  const disclosed: FeedItem[] = [];
  const hiddenReadingNow = frame.hiddenReadingActors;
  for (const [index, item] of items.entries()) {
    const finalSource = final.get(item.id);
    if (!finalSource || !personFeedSourceVisible(finalSource, reader?.agent ?? null,
      personSettings?.blockedPeople ?? [], hiddenReadingNow)) continue;
    try {
      const actor = finalActors.get(item.actor.id);
      if (!actor) throw new WorkReadMissing('Agent unavailable');
      if (actor.displayName !== item.actor.name || actor.handle !== item.actor.handle) throw new WorkReadMoved('Actor changed');
      if (item.target.work && !targetFence.works.has(item.target.work)
        || item.realm && !targetFence.realms.has(item.realm.id)) throw new WorkReadMissing('Follow target is unavailable');
      for (const id of [item.target.work, item.realm?.id].filter((id): id is string => !!id)) {
        if (JSON.stringify(summaries.get(id)) !== JSON.stringify(targetFence.fenced.get(id))) throw new WorkReadMoved('Card summary changed');
      }
      if (finalSource.kind !== item.kind || finalSource.work !== item.target.work
        || !matchesFeedInterest(finalSource, interests, finalWorkKinds)
        || finalSource.work && matchingActivityKinds(finalSource.kind).length === 0
          && JSON.stringify(workKinds.get(finalSource.work))
          !== JSON.stringify(finalWorkKinds.get(finalSource.work))) throw new WorkReadMoved('Feed interest changed');
      const initial = itemSources[index]!;
      if (item.kind !== 'review' && graphFields(finalSource) !== graphFields(initial)) throw new WorkReadMoved('Feed source changed');
      unwrap(replyChecks[index]!);
      if (item.kind === 'review' && (finalSource.readerReview?.revision !== initial.readerReview?.revision
        || finalSource.readerReview?.helpful_count !== (item.card.kind === 'review' ? item.card.helpfulCount : -1))) {
        throw new WorkReadMoved('Review changed');
      }
      if (item.card.kind === 'chapter') {
        if (!initial.occurrence || initial.occurrence !== finalSource.occurrence
          || initial.contentTarget !== finalSource.contentTarget
          || initial.contentRevision !== finalSource.contentRevision
          || initial.excerpt !== finalSource.excerpt || initial.language !== finalSource.language
          || initialChapters.get(initial.occurrence) !== finalChapters.get(initial.occurrence)) {
          throw new WorkReadMoved('Chapter content changed');
        }
      }
      if (item.card.kind === 'list') unwrap(targetFence.lists[index]!);
      if (fenceCards(item)) {
        // A review card is the review row itself, so it is rebuilt from the final row.
        const card = item.kind === 'review' ? await feedCardData(session, finalSource, item.target,
          item.links.target, undefined, personSettings?.spoilerPolicy === 'show')
          : unwrap(cardChecks[index]!);
        if (JSON.stringify(card.card) !== JSON.stringify(item.card)
          || JSON.stringify(card.primaryAction) !== JSON.stringify(item.primaryAction)) throw new WorkReadMoved('Card content changed');
      }
      disclosed.push(item);
    } catch (error) { if (!(error instanceof WorkReadMissing)) throw error; }
  }
  const fenceTargets = disclosed.flatMap(item => {
    const source = final.get(item.id)!;
    return [{ owner: source.kind === 'review' ? 'review' as const : 'graph' as const,
      resource: source.id, component: 'body' as const, revision: source.readerReview?.revision, work: source.work,
      context: source.realm ?? undefined },
    { owner: 'content' as const, resource: source.reply ?? source.contentTarget ?? source.target,
      component: 'body' as const, revision: source.contentRevision?.replace(/^urn:rezics:content:revision:/, '') ?? null,
      work: source.work, context: source.realm ?? undefined }];
  });
  const policy = await session.disclosure(fenceTargets, 'feed');
  const hidden = new Set(disclosed.filter((_item, index) => policy[index * 2] !== 'visible'
    || policy[index * 2 + 1] !== 'visible').map(item => item.id));
  const safe = disclosed.filter(item => !hidden.has(item.id));
  const { chosen: selected, seen, realms } = select(safe);
  followedSeen = seen; recentRealms = realms;
  const targets = viewerTargets(selected);
  const states = unwrap(await readViewer(targets));
  for (const item of selected) {
    if (hidden.has(item.id)) continue;
    const rawState = states?.get(item.id) ?? { status: reader ? 'unavailable' : 'anonymous' };
    const state = rawState.status === 'available' && personSettings?.spoilerPolicy === 'show'
      ? { ...rawState, spoiler: { policy: 'show' as const, hidden: false } } : rawState;
    if (!Value.Check(feedViewerState, state)) throw new WorkReadUnavailable('Viewer state differs');
    item.viewerState = state;
    if (state.status === 'available' && state.nextUnread && item.card.kind === 'chapter'
      && state.nextUnread.work === item.target.work) {
      const next = state.nextUnread;
      item.primaryAction = { kind: 'next-unread', work: next.work, occurrence: next.occurrence,
        href: `/w/${next.work.slice(-36)}/read/${next.occurrence.slice(-36)}${next.language ? `?language=${encodeURIComponent(next.language)}` : ''}` };
    }
    if (state.status === 'available' && state.spoiler.hidden) {
      item.target = { ...item.target, excerpt: null };
      // A chapter's title can spoil as much as its words.
      item.post = { ...item.post, title: item.card.kind === 'chapter' ? null : item.post.title, excerpt: null };
      if (item.card.kind === 'chapter') item.card = { kind: 'chapter', occurrence: item.card.occurrence, parent: item.card.parent,
        ...(item.card.number !== undefined ? { number: item.card.number } : {}) };
      if (item.card.kind === 'prompt') item.card = { kind: 'prompt' };
    }
  }
  const projected = checkpoint.sequence === session.position.sequence && checkpoint.after_id === '\uffff'
    && !checkpoint.rebuild_epoch;
  const content = new Map([...sources.flatMap(source => source.publishedContent ? [[source.publishedContent.revisionId,source.publishedContent.reference.byteDigest] as const] : []),
    ...[...cardParts.hubs.values()].map(hub => [hub.exact.revisionId,hub.exact.reference.byteDigest] as const)]);
  if (content.size) {
    const ids = [...content.keys()];
    const current = session.deps.contentAuthoring
      ? await session.deps.contentAuthoring.readExactMetadataBatch(ids,async keys => new Set(keys))
      : new Map((await Promise.all(Array.from({ length: Math.ceil(ids.length/4) },(_,batch) =>
        session.deps.content!.readExactBatch(ids.slice(batch*4,batch*4+4),async keys => new Set(keys))))).flat()
        .map(row => [row.revisionId,{ availability: row.status,
          byteDigest: row.status === 'available' ? row.reference.byteDigest : '' }] as const));
    if ([...content].some(([id,digest]) => current.get(id)?.availability !== 'available' || current.get(id)?.byteDigest !== digest))
      throw new WorkReadMoved('Card Content changed');
  }
  await session.fenceSummaryMedia();
  const { pending, watermark } = await frame.close();
  const last = page.at(-1);
  const current = projected && !pending && (scope !== 'following' || sort !== 'new'
    || frame.followingIndexCurrent(session.position.sequence));
  return { profile: 'home-feed-v1' as const, scope, sort, window, ranking: FEED_RANKING,
    caughtUp: scope === 'following' && sort === 'new' ? { asOf: new Date(asOf).toISOString(),
      lastVisitedAt: watermark?.data_epoch === session.position.dataEpoch
        ? watermark.updated_at.toISOString() : null,
      state: more ? 'more' as const : current ? 'caught-up' as const : 'projecting' as const } : null,
    ...pageResult(session, selected.map(item => hidden.has(item.id)
      ? feedTombstone(item) : item), more && last
      ? encodeReadCursor(binding, session.position, last.id, JSON.stringify({ key: last.order_key,
        projection: checkpoint.revision, following: scope === 'following' ? following?.revision ?? null : null,
        targetIndex: scope === 'following' && sort === 'new' ? frame.followingIndexRevision : null,
        personal: personal?.revision ?? null,
        asOf, recentRealms, followedSeen })) : null),
    projection: { sequence: checkpoint.sequence, reviewSequence: checkpoint.review_sequence,
      status: current ? 'current' as const : 'catching-up' as const } };
}
