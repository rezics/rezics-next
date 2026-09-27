import type { FeedReader } from './read.ts';
import { excludedFeedSource } from './read.ts';
import { feedSources } from './source.ts';
import { WorkReadInvalid, WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { digest } from '../recommendation/derived-generation.ts';

export const HEAD_COST = { candidates: 20 } as const;
/** The head probe reports only currently admitted public references. When the
 * fixed probe fills, the count is a lower bound and zero remains unknown. */
export async function readNewSince(session: WorkReadSession, afterSequence: string,
  scope: 'all' | 'following' | `realm:${string}`, reader?: FeedReader) {
  const { feed, follows, homePersonal } = session.deps;
  if (!feed || !follows) throw new WorkReadUnavailable('Feed is unavailable');
  if (scope !== 'all' && !reader) throw new WorkReadInvalid('Authentication is required');
  const checkpoint = await feed.checkpoint(session.position.dataEpoch);
  if (BigInt(afterSequence) > BigInt(checkpoint.sequence)) throw new WorkReadMoved('Feed position moved');
  const realm = scope.startsWith('realm:') ? scope.slice(6) : undefined;
  const personal = reader && homePersonal ? await homePersonal.read(reader.principal, reader.agent) : null;
  if (reader && !personal) throw new WorkReadUnavailable('Home preferences are unavailable');
  const tagRules = personal?.exclusions.filter(rule => rule.kind === 'tag') ?? [];
  const cap = tagRules.length ? 8 : HEAD_COST.candidates;
  const rows = await feed.since(session.position, checkpoint.revision, afterSequence, realm, cap);
  const sources = await feedSources(session, { ids: rows.slice(0, cap).map(row => row.id) });
  const groups = new Set<string>();
  const filtered = [];
  const tagMatches = new Map<string, string[]>();
  for (const source of sources) {
    if (personal && excludedFeedSource(source, personal.exclusions)) continue;
    if (personal?.preferences.contentLanguages.length && (!source.language
      || !personal.preferences.contentLanguages.some(language => language.toLowerCase() === source.language!.toLowerCase()))) continue;
    if (source.work && tagRules.length) {
      const key = JSON.stringify([source.work, source.realm]);
      if (!tagMatches.has(key)) {
        const tagSession = new WorkReadSession(session.deps, session.request,
          { limit: 3, ...(source.realm ? { scope: 'realm', realm: source.realm } : {}) }, session.position);
        const result = await readWorkClassifications(tagSession, source.work, tagRules.map(rule => rule.target));
        tagMatches.set(key, result.items.map(item => item.sense));
      }
      if (tagRules.some(rule => tagMatches.get(key)?.includes(rule.target)
        && (rule.strength !== 'fewer'
          || Number.parseInt(digest([source.id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0))) continue;
    }
    const key = rows.find(row => row.id === source.id)?.group_key;
    if (!key || groups.has(key)) continue;
    groups.add(key);
    filtered.push(source);
  }
  const matches = reader && scope === 'following' ? await follows.matches(reader.principal, reader.agent,
    filtered.map(source => [source.realm, source.zone, source.work, source.actor]
      .filter((id): id is string => !!id))) : null;
  const count = matches ? matches.matches.filter(Boolean).length : filtered.length;
  if ((await feed.checkpoint(session.position.dataEpoch)).revision !== checkpoint.revision
    || reader && personal && (await homePersonal!.read(reader.principal, reader.agent)).revision !== personal.revision) {
    throw new WorkReadMoved('Feed head changed');
  }
  if (reader && matches && (await follows.matches(reader.principal, reader.agent, [])).revision !== matches.revision) {
    throw new WorkReadMoved('Follows changed');
  }
  const complete = rows.length <= cap;
  return { profile: 'home-feed-head-v1' as const, scope, afterSequence,
    newPosts: { value: count, kind: complete ? 'exact' as const : 'lower-bound' as const },
    state: checkpoint.sequence === session.position.sequence && checkpoint.after_id === '\uffff'
      && !checkpoint.rebuild_epoch ? complete ? 'current' as const : 'more' as const : 'projecting' as const,
    projection: { sequence: checkpoint.sequence, dataEpoch: checkpoint.data_epoch } };
}
