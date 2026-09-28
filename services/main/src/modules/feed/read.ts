import { Value } from 'typebox/value';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { ResourceSummary } from '../media/summary.ts';
import { readFollowTarget } from '../follows/read.ts';
import { readAgent } from '../profiles/read.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadMissing,
  WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { FEED_COST, feedViewerState, type FeedItem, type FeedQuery } from './contract.ts';
import { feedReviewSources, feedSources, type FeedSource } from './source.ts';
import type { FeedRow } from './store.ts';
import { feedCardData } from './cards.ts';
import { diversityAllows, FEED_RANKING, recommendationAllowed } from './ranking.ts';
import { digest } from '../recommendation/derived-generation.ts';
import type { HomeExclusion } from './personal.ts';
import { readWorkKindMatches } from '../onboarding-interests/read.ts';
import { interestKinds, matchingActivityKinds } from '../work/work-kinds.ts';
import type { HomeInterestKind } from '../onboarding-interests/contract.ts';
import { feedWorkPresentations, type FeedWorkPresentation } from './presentation.ts';

export interface FeedReader { principal: VerifiedPrincipal; agent: string }

export async function visibleFeedSources(session: WorkReadSession, rows: readonly { id: string; kind: string }[]) {
  const graph = rows.filter(row => row.kind !== 'review').map(row => row.id);
  const reviews = rows.filter(row => row.kind === 'review').map(row => row.id);
  return [...await feedSources(session, { ids: graph }), ...await feedReviewSources(session, reviews)];
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
  return { excerpt: body.body.body.slice(0, 400),
    language: body.reference.language.kind === 'tag' ? body.reference.language.tag : null };
}

/** Counts only currently approved, visible placements. A global card counts
 * one public Realm thread; if more Realms exist its count is a lower bound.
 * Each owner count probes at most 64 placements, never an unbounded aggregate. */
async function comments(session: WorkReadSession, source: FeedSource): Promise<FeedItem['comments']> {
  if (!source.work) return { value: 0, kind: 'exact' };
  const realms = source.realm ? [source.realm] : (await session.query(`SELECT DISTINCT ?realm WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmReplySlot ; rv:rootTarget ${iri(source.work)} ; rv:realm ?realm .
      ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
      FILTER NOT EXISTS { ?realm rv:protectionHead ?protection } }
  } ORDER BY STR(?realm) LIMIT 2`, 2)).map(row => row.realm!.value);
  if (!realms[0]) return { value: 0, kind: 'exact' };
  if (!session.deps.realmReplies) throw new WorkReadUnavailable('Comment count owner is unavailable');
  const count = await session.deps.realmReplies.rootCount(realms[0], source.work);
  return { value: count.count, kind: count.complete && realms.length === 1 ? 'exact' : 'lower-bound' };
}

export async function hydrateFeedItem(session: WorkReadSession, source: FeedSource, row: FeedRow,
  summaries?: ReadonlyMap<string, ResourceSummary>, presentation?: FeedWorkPresentation): Promise<FeedItem> {
  const actor = await readAgent(session, source.actor);
  const target = source.work ? await readFollowTarget(session, source.work, 'work', summaries) : null;
  const realm = source.realm ? await readFollowTarget(session, source.realm, 'realm', summaries) : null;
  const body = await replyExcerpt(session, source);
  const href = target?.href ?? `/collections/${source.target.slice(-36)}`;
  const reviewHref = source.readerReview ? `${href}#review-${source.readerReview.id}` : href;
  const reasons: FeedItem['reasons'] = source.kind === 'work' ? [{ kind: 'new-work', actor: source.actor }]
    : source.kind === 'added' ? [{ kind: 'added-to-rezics', actor: source.actor }]
      : source.kind === 'adoption' && source.realm
        ? [{ kind: 'realm-pick', realm: source.realm, curator: source.actor }] : [];
  const item: FeedItem = { id: source.id, kind: source.kind, authors: presentation?.authors ?? [], reasons,
    reason: { kind: 'recommended', basis: 'all' }, group: { key: row.group_key, count: 1,
      actors: [{ id: actor.id, name: actor.displayName, handle: actor.handle }] },
    card: { kind: 'activity' }, primaryAction: { kind: 'open', href }, viewerState: { status: 'anonymous' },
    actor: { id: actor.id, name: actor.displayName, handle: actor.handle },
    target: { id: source.target, work: source.work,
      title: target?.name ?? { value: source.title ?? '', language: 'en', direction: 'ltr', basis: 'fallback' },
      cover: target?.icon ?? { kind: 'fallback', policy: 'avatar-fallback-v1', key: source.target, resourceType: 'collection' },
      types: presentation?.types ?? [],
      excerpt: source.kind === 'work' || source.kind === 'added' || source.kind === 'adoption'
        ? presentation?.excerpt ?? body.excerpt : body.excerpt,
      language: source.kind === 'work' || source.kind === 'added' || source.kind === 'adoption'
        ? presentation?.language ?? body.language : body.language },
    realm: realm ? { id: realm.id, name: realm.name, icon: realm.icon } : null,
    time: row.occurred_at.toISOString(), timeBasis: row.time_basis, score: row.score,
    vote: row.vote ?? 0, voteRevision: row.vote_revision ?? null, comments: await comments(session, source),
    links: { target: source.readerReview ? reviewHref : source.reply ? `${href}/discussion#${source.reply.slice(-36)}` : href,
      actor: actor.links.profile, comments: source.work ? `${href}/discussion` : href,
      vote: `/v1/feed/${source.id.slice(-36)}/vote` } };
  return { ...item, ...await feedCardData(session, source, item.target, item.links.target) };
}

export async function admitFeedVote(session: WorkReadSession, target: string) {
  const kind = (await session.deps.feed?.members(session.position.dataEpoch, [target]))?.[0]?.kind;
  const source = (await visibleFeedSources(session, [{ id: target, kind: kind ?? '' }]))[0];
  if (!source) throw new WorkReadMissing('Feed activity unavailable');
  await readAgent(session, source.actor);
  if (source.work) await readFollowTarget(session, source.work, 'work');
  if (source.realm) await readFollowTarget(session, source.realm, 'realm');
  await replyExcerpt(session, source);
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

const normalized = (query: FeedQuery) => [
  [...(query.kinds ?? [])].sort(), [...new Set((query.contentLanguages ?? []).map(value => value.toLowerCase()))].sort(),
  [...(query.realms ?? [])].sort(), [...(query.tags ?? [])].sort(), query.language?.toLowerCase() ?? null,
  parseFeedInterests(query.interests).sort(),
];

export async function readFeed(session: WorkReadSession, query: FeedQuery, reader?: FeedReader) {
  const interests = parseFeedInterests(query.interests);
  const store = session.deps.feed;
  const follows = session.deps.follows;
  if (!store || !follows) throw new WorkReadUnavailable('Feed owner is unavailable');
  const personal = reader && session.deps.homePersonal
    ? await session.deps.homePersonal.read(reader.principal, reader.agent) : null;
  if (reader && !personal) throw new WorkReadUnavailable('Home preferences are unavailable');
  if (!query.contentLanguages && personal?.preferences.contentLanguages.length) {
    query = { ...query, contentLanguages: personal.preferences.contentLanguages };
  }
  const scope = query.scope ?? personal?.preferences.tab ?? 'all';
  if (scope === 'following' && !reader) throw new WorkReadInvalid('Following requires authentication');
  const sort = query.sort ?? personal?.preferences.sort ?? 'best', window = query.window ?? 'all';
  if (scope === 'following' && sort === 'top') throw new WorkReadInvalid('Top is available in All');
  const watermark = reader && scope === 'following' && sort === 'new'
    ? await session.deps.homePersonal!.getWatermark(reader.principal, reader.agent, 'following') : null;
  const checkpoint = await store.checkpoint(session.position.dataEpoch);
  const following = reader ? await follows.matches(reader.principal, reader.agent, []) : null;
  const binding = ['home-feed-v1', FEED_RANKING.version, scope, sort, window, normalized(query),
    following?.owner ?? null, reader?.agent ?? null];
  const cursor = decodeReadCursor(query.cursor, binding, session.position);
  let after: { key: string; id: string } | undefined;
  let asOf = Date.now(), followedSeen = 0;
  let recentRealms: (string | null)[] = [];
  if (cursor) {
    let order: { key: string; projection: string; following: string | null; personal: string | null;
      asOf: number; followedSeen: number; recentRealms: (string | null)[] };
    try {
      order = JSON.parse(cursor.order) as typeof order;
      if (!order || typeof order.key !== 'string' || typeof order.projection !== 'string'
        || (order.personal !== null && typeof order.personal !== 'string')
        || !Number.isSafeInteger(order.asOf) || !Number.isInteger(order.followedSeen)
        || order.followedSeen < 0 || order.followedSeen > FEED_RANKING.thinFollowing || !Array.isArray(order.recentRealms)
        || order.recentRealms.length > 9 || order.recentRealms.some(id => id !== null && typeof id !== 'string')) throw new Error('cursor');
    } catch { throw new WorkReadInvalid('Invalid feed cursor'); }
    if (order.projection !== checkpoint.revision || order.personal !== (personal?.revision ?? null)
      || (scope === 'following' && order.following !== following?.revision)) {
      throw new WorkReadMoved('Feed changed');
    }
    after = { id: cursor.after, key: order.key }; asOf = order.asOf; recentRealms = order.recentRealms; followedSeen = order.followedSeen;
  }
  const limit = Math.min(query.limit ?? FEED_COST.pageSize, query.tags ? FEED_COST.tagCandidates : FEED_COST.candidates);
  const rows = await store.page(session.position, checkpoint.revision, sort, limit, after, reader, window, asOf);
  const page: FeedRow[] = [];
  let members = 0;
  for (const row of rows.slice(0, limit)) {
    if (members + row.group_members.length > FEED_COST.candidates) break;
    page.push(row); members += row.group_members.length;
  }
  const cutoff = window === 'all' ? 0 : asOf - (window === 'week' ? 7 : 30) * 86_400_000;
  const withinWindow = page.filter(row => row.sort_time.getTime() >= cutoff && row.sort_time.getTime() <= asOf);
  const memberRows = await store.members(session.position.dataEpoch, withinWindow.flatMap(row => row.group_members));
  const sources = await visibleFeedSources(session, memberRows);
  const initialChapters = await chapterPointers(session, sources);
  // At most eight member Works enter this one bounded catalogue read. The
  // same type and accepted-Sense relation powers onboarding suggestions.
  const workKinds = interests.length ? await readWorkKindMatches(session, [...new Set(sources
    .filter(source => matchingActivityKinds(source.kind).length === 0)
    .flatMap(source => source.work ? [source.work] : []))]) : new Map();
  const summaryIds = [...new Set(sources.flatMap(source => [source.work, source.realm].filter((id): id is string => !!id)))];
  const summaries = new Map((await session.summaries(summaryIds)).map(summary => [summary.reference, summary]));
  const presentationBatch = await feedWorkPresentations(session, sources.flatMap(source => source.work ? [source.work] : []));
  const presentations = presentationBatch.items;
  const matches = reader && scope === 'following' ? await follows.matches(reader.principal, reader.agent,
    sources.map(source => [source.realm, source.zone, source.work, source.actor].filter((id): id is string => !!id))) : null;
  const items: FeedItem[] = [];
  const acceptedTags = new Map<string, boolean>();
  const tagRules = personal?.exclusions.filter(rule => rule.kind === 'tag') ?? [];
  const tagMatches = new Map<string, string[]>();
  for (const [index, source] of sources.entries()) {
    if (personal && excludedFeedSource(source, personal.exclusions)) continue;
    if (query.kinds && !query.kinds.includes(source.kind)) continue;
    if (!matchesFeedInterest(source, interests, workKinds)) continue;
    if (query.realms && (!source.realm || !query.realms.includes(source.realm))) continue;
    if (source.work && tagRules.length) {
      const key = JSON.stringify([source.work, source.realm]);
      if (!tagMatches.has(key)) {
        const tagSession = new WorkReadSession(session.deps, session.request, { language: query.language,
          limit: 3, ...(source.realm ? { scope: 'realm', realm: source.realm } : {}) }, session.position);
        const tags = await readWorkClassifications(tagSession, source.work, tagRules.map(rule => rule.target));
        tagMatches.set(key, tags.items.map(item => item.sense));
      }
      if (tagRules.some(rule => tagMatches.get(key)?.includes(rule.target)
        && (rule.strength !== 'fewer'
          || Number.parseInt(digest([source.id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0))) continue;
    }
    try {
      const item = await hydrateFeedItem(session, source, memberRows.find(row => row.id === source.id)!, summaries,
        source.work ? presentations.get(source.work) : undefined);
      const followed = matches?.reasons[index]?.[0];
      item.reason = followed ? { kind: 'followed', target: followed.target, targetKind: followed.kind }
        : { kind: 'recommended', basis: scope === 'following' ? 'thin-following' : 'all' };
      if (query.contentLanguages && (!item.target.language
        || !query.contentLanguages.some(language => language.toLowerCase() === item.target.language!.toLowerCase()))) continue;
      if (query.tags) {
        if (!source.work) continue;
        const key = JSON.stringify([source.work, source.realm]);
        if (!acceptedTags.has(key)) {
          const tagSession = new WorkReadSession(session.deps, session.request, { language: query.language,
            limit: 3, ...(source.realm ? { scope: 'realm', realm: source.realm } : {}) }, session.position);
          const tags = await readWorkClassifications(tagSession, source.work, query.tags);
          acceptedTags.set(key, query.tags.some(tag => tags.items.some(item => item.sense === tag)));
        }
        if (!acceptedTags.get(key)) continue;
      }
      items.push(item);
    } catch (error) { if (!(error instanceof WorkReadMissing)) throw error; }
  }
  const final = await visibleFeedSources(session, items);
  const finalChapters = await chapterPointers(session, final);
  const finalWorkKinds = interests.length ? await readWorkKindMatches(session,
    [...new Set(final.filter(source => matchingActivityKinds(source.kind).length === 0)
      .flatMap(source => source.work ? [source.work] : []))]) : new Map();
  const valid = new Set(final.map(source => source.id));
  const fenced = new Map((await session.summaries(summaryIds)).map(summary => [summary.reference, summary]));
  await presentationBatch.fence();
  const disclosed: FeedItem[] = [];
  for (const item of items) {
    if (!valid.has(item.id)) continue;
    try {
      const actor = await readAgent(session, item.actor.id);
      if (actor.displayName !== item.actor.name || actor.handle !== item.actor.handle) throw new WorkReadMoved('Actor changed');
      if (item.target.work) await readFollowTarget(session, item.target.work, 'work', fenced);
      if (item.realm) await readFollowTarget(session, item.realm.id, 'realm', fenced);
      for (const id of [item.target.work, item.realm?.id].filter((id): id is string => !!id)) {
        if (JSON.stringify(summaries.get(id)) !== JSON.stringify(fenced.get(id))) throw new WorkReadMoved('Card summary changed');
      }
      const finalSource = final.find(source => source.id === item.id)!;
      if (finalSource.kind !== item.kind || finalSource.work !== item.target.work
        || !matchesFeedInterest(finalSource, interests, finalWorkKinds)
        || finalSource.work && matchingActivityKinds(finalSource.kind).length === 0
          && JSON.stringify(workKinds.get(finalSource.work))
          !== JSON.stringify(finalWorkKinds.get(finalSource.work))) throw new WorkReadMoved('Feed interest changed');
      await replyExcerpt(session, finalSource);
      if (item.kind === 'review' && (finalSource.readerReview?.revision !== sources.find(source => source.id === item.id)?.readerReview?.revision
        || finalSource.readerReview?.helpful_count !== (item.card.kind === 'review' ? item.card.helpfulCount : -1))) {
        throw new WorkReadMoved('Review changed');
      }
      if (item.card.kind === 'chapter') {
        const earlier = sources.find(source => source.id === item.id)!;
        if (!earlier.occurrence || earlier.occurrence !== finalSource.occurrence
          || earlier.contentTarget !== finalSource.contentTarget
          || earlier.contentRevision !== finalSource.contentRevision
          || earlier.excerpt !== finalSource.excerpt || earlier.language !== finalSource.language
          || initialChapters.get(earlier.occurrence) !== finalChapters.get(earlier.occurrence)) {
          throw new WorkReadMoved('Chapter content changed');
        }
      }
      if (item.card.kind === 'prompt' || item.card.kind === 'release' || item.card.kind === 'review'
        || item.card.kind === 'list') {
        const card = await feedCardData(session, finalSource, item.target, item.links.target);
        if (JSON.stringify(card.card) !== JSON.stringify(item.card)
          || JSON.stringify(card.primaryAction) !== JSON.stringify(item.primaryAction)) throw new WorkReadMoved('Card content changed');
      }
      disclosed.push(item);
    } catch (error) { if (!(error instanceof WorkReadMissing)) throw error; }
  }
  const groups = page.flatMap(row => {
    // The stable voting/group anchor must remain public. Never expose a hidden
    // anchor through a surviving sibling's card, count or timestamp.
    if (!disclosed.some(item => item.id === row.id)) return [];
    let entries = disclosed.filter(item => row.group_members.includes(item.id));
    const followed = entries.filter(item => item.reason.kind === 'followed');
    if (scope === 'following' && followed.length) entries = followed;
    entries.sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
    const latest = entries[0]!;
    const start = entries.filter(item => item.primaryAction.kind === 'read-chapter').sort((a, b) =>
      (a.card.kind === 'chapter' ? a.card.number ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY)
      - (b.card.kind === 'chapter' ? b.card.number ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY))[0];
    const actors = [...new Map(entries.map(item => [item.actor.id, item.actor])).values()].slice(0, 3);
    const chapters = entries.flatMap(item => item.card.kind === 'chapter' && item.card.number !== undefined ? [item.card.number] : []);
    return [{ ...latest, ...(start ? { primaryAction: start.primaryAction } : {}), id: row.id, time: row.occurred_at.toISOString(), timeBasis: row.time_basis,
      score: row.score, vote: row.vote, voteRevision: row.vote_revision,
      links: { ...latest.links, vote: `/v1/feed/${row.id.slice(-36)}/vote` },
      group: { key: row.group_key, count: entries.length, actors,
        ...(chapters.length === entries.length && new Set(entries.map(item => item.card.kind === 'chapter' ? item.card.parent : null)).size === 1 ? { range: { kind: 'chapters' as const,
          from: Math.min(...chapters), to: Math.max(...chapters) } } : {}) } }];
  });
  const collapsed = collapseReviewCards(collapseWorkCards(groups));
  const more = rows.length > page.length;
  followedSeen = Math.min(FEED_RANKING.thinFollowing, followedSeen + collapsed.filter(item => item.reason.kind === 'followed').length);
  // A sparse page is not evidence that Following is thin. Prove it by an
  // empty follow inventory or by exhausting this view's candidate relation.
  const thinKnown = following?.count === 0 || !more;
  const allowRecommendations = scope === 'all' || personal?.preferences.recommendations !== false
    && thinKnown && recommendationAllowed(scope, sort, followedSeen);
  const selected = collapsed.filter(item => {
    if (scope === 'following' && item.reason.kind !== 'followed' && !allowRecommendations) return false;
    if (sort === 'best' && !diversityAllows(item.realm?.id ?? null, recentRealms)) return false;
    recentRealms = [...recentRealms, item.realm?.id ?? null].slice(-9);
    return true;
  });
  const states = reader && session.deps.feedViewerState ? await session.deps.feedViewerState.read(reader,
    selected.map(item => ({ activity: item.id, work: item.target.work,
      ...(item.card.kind === 'chapter' ? { occurrence: item.card.occurrence } : {}) })), session) : undefined;
  for (const item of selected) {
    const state = states?.get(item.id) ?? { status: reader ? 'unavailable' : 'anonymous' };
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
      if (item.card.kind === 'chapter') item.card = { kind: 'chapter', occurrence: item.card.occurrence, parent: item.card.parent,
        ...(item.card.number !== undefined ? { number: item.card.number } : {}) };
      if (item.card.kind === 'prompt') item.card = { kind: 'prompt' };
    }
  }
  if ((await store.checkpoint(session.position.dataEpoch)).revision !== checkpoint.revision) throw new WorkReadMoved('Feed changed');
  if (reader && (await follows.matches(reader.principal, reader.agent, [])).revision !== following?.revision) {
    throw new WorkReadMoved('Follows changed');
  }
  if (reader && (await session.deps.homePersonal?.read(reader.principal, reader.agent))?.revision !== personal?.revision) {
    throw new WorkReadMoved('Home preferences changed');
  }
  const last = page.at(-1);
  const current = checkpoint.sequence === session.position.sequence && checkpoint.after_id === '\uffff'
    && !checkpoint.rebuild_epoch && !await store.reviewPending(checkpoint.review_sequence);
  return { profile: 'home-feed-v1' as const, scope, sort, window, ranking: FEED_RANKING,
    caughtUp: scope === 'following' && sort === 'new' ? { asOf: new Date(asOf).toISOString(),
      lastVisitedAt: watermark?.data_epoch === session.position.dataEpoch
        ? watermark.updated_at.toISOString() : null,
      state: more ? 'more' as const : current ? 'caught-up' as const : 'projecting' as const } : null,
    ...pageResult(session, selected, more && last
      ? encodeReadCursor(binding, session.position, last.id, JSON.stringify({ key: last.order_key,
        projection: checkpoint.revision, following: scope === 'following' ? following?.revision ?? null : null,
        personal: personal?.revision ?? null,
        asOf, recentRealms, followedSeen })) : null),
    projection: { sequence: checkpoint.sequence, reviewSequence: checkpoint.review_sequence,
      status: current ? 'current' as const : 'catching-up' as const } };
}
