import type { FeedReader } from './read.ts';
import { contentLanguageVisible, excludedFeedSource, visibleFeedSources } from './read.ts';
import { WorkReadInvalid, WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { digest } from '../recommendation/derived-generation.ts';
import { AUTHOR_NEWS_KINDS, feedWorkAuthors, followIdentities } from './presentation.ts';
import { compareMainFeedPosition, requireMainFeedCoverage } from './frame.ts';
import { discloseRealmOccurrences } from '../disclosure/realm-occurrences.ts';

export const HEAD_COST = { candidates: 20 } as const;
/** The head probe reports only currently admitted public references. When the
 * fixed probe fills, the count is a lower bound and zero remains unknown. */
export async function readNewSince(session: WorkReadSession, afterSequence: string,
  scope: 'all' | 'following' | `realm:${string}`, reader?: FeedReader, afterReview?: string) {
  const { feed, follows, homePersonal } = session.deps;
  if (!feed || !follows) throw new WorkReadUnavailable('Feed is unavailable');
  if (scope !== 'all' && !reader) throw new WorkReadInvalid('Authentication is required');
  const checkpoint = await feed.checkpoint(session.position.dataEpoch);
  const coverage = requireMainFeedCoverage(await session.deps.relayPosition?.read(), checkpoint.data_epoch);
  const checkpointOrder = compareMainFeedPosition(checkpoint.data_epoch, checkpoint.sequence, coverage);
  if (checkpointOrder > 0) throw new WorkReadUnavailable('Feed exceeds relay');
  if (BigInt(afterSequence) > BigInt(checkpoint.sequence)) throw new WorkReadMoved('Feed position moved');
  const realm = scope.startsWith('realm:') ? scope.slice(6) : undefined;
  const personal = reader && homePersonal ? await homePersonal.read(reader.principal, reader.agent) : null;
  if (reader && !personal) throw new WorkReadUnavailable('Home preferences are unavailable');
  if (personal) session.readingLanguages = personal.preferences.contentLanguages;
  const tagRules = personal?.exclusions.filter(rule => rule.kind === 'tag') ?? [];
  const cap = tagRules.length ? 8 : HEAD_COST.candidates;
  const rows = await feed.since(session.position, checkpoint.revision, afterSequence, realm, cap, afterReview);
  const sources = await visibleFeedSources(session, rows.slice(0, cap));
  const filtered = [];
  const tagMatches = new Map<string, string[]>();
  for (const source of sources) {
    if (personal && excludedFeedSource(source, personal.exclusions)) continue;
    if (!contentLanguageVisible(source.language, [undefined, personal?.preferences.contentLanguages])) continue;
    if (source.work && tagRules.length) {
      const key = JSON.stringify([source.work, source.realm]);
      if (!tagMatches.has(key)) {
        const tagSession = new WorkReadSession(session.deps, session.request,
          { languages: session.displayLanguages.join(','), limit: 3,
            ...(source.realm ? { scope: 'realm', realm: source.realm } : {}) }, session.position);
        const result = await readWorkClassifications(tagSession, source.work, tagRules.map(rule => rule.target));
        tagMatches.set(key, result.items.map(item => item.sense));
      }
      if (tagRules.some(rule => tagMatches.get(key)?.includes(rule.target)
        && (rule.strength !== 'fewer'
          || Number.parseInt(digest([source.id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0))) continue;
    }
    filtered.push(source);
  }
  // The feed's own match: an author's news also answers to follows of its credited authors.
  const authors = reader && scope === 'following' ? await feedWorkAuthors(session, filtered.flatMap(source =>
    source.work && AUTHOR_NEWS_KINDS.includes(source.kind) ? [source.work] : [])) : null;
  const matches = reader && scope === 'following' ? await follows.matches(reader.principal, reader.agent,
    filtered.map(source => followIdentities(source, source.work ? authors?.get(source.work) : undefined))) : null;
  if ((await feed.checkpoint(session.position.dataEpoch)).revision !== checkpoint.revision
    || reader && personal && (await homePersonal!.fence(reader.principal, reader.agent)).revision !== personal.revision) {
    throw new WorkReadMoved('Feed head changed');
  }
  if (reader && matches && (await follows.matches(reader.principal, reader.agent, [])).revision !== matches.revision) {
    throw new WorkReadMoved('Follows changed');
  }
  const reviewPending = await feed.reviewPending(checkpoint.review_sequence);
  const matched = filtered.filter((_, index) => !matches || matches.matches[index]);
  // Include the requested scope in the same final audience batch: a closed
  // Realm is exact zero even when its retained source probe was truncated.
  const visible = await discloseRealmOccurrences(session.deps.environment,
    [...matched, ...(realm ? [{ realm }] : [])], session.viewer, 'count');
  const visibleRealms = new Set(visible.map(source => source.realm));
  const scopeVisible = !realm || visibleRealms.has(realm);
  const groups = new Set(matched.filter(source => !source.realm || visibleRealms.has(source.realm)).map(source =>
    source.kind === 'review' && source.readerReview
      ? digest(['review', source.actor, source.realm, source.readerReview.created_at.toISOString().slice(0, 13)])
      : rows.find(row => row.id === source.id)?.group_key).filter((key): key is string => !!key));
  const count = scopeVisible ? groups.size : 0;
  const complete = !scopeVisible || rows.length <= cap;
  return { profile: 'home-feed-head-v1' as const, scope, afterSequence,
    newPosts: { value: count, kind: complete ? 'exact' as const : 'lower-bound' as const },
    state: checkpointOrder === 0 && checkpoint.after_id === '\uffff' && !reviewPending
      && !checkpoint.rebuild_epoch ? complete ? 'current' as const : 'more' as const : 'projecting' as const,
    projection: { sequence: checkpoint.sequence, reviewSequence: checkpoint.review_sequence,
      dataEpoch: checkpoint.data_epoch } };
}
