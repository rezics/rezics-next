import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '../src/app.ts';
import { activityTime, bestKey, bestScore, FEED_DECAY_MS, FEED_RANKING, rankCandidates, diversityAllows, recommendationAllowed } from '../src/modules/feed/ranking.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMoved } from '../src/modules/work/read-session.ts';
import { describeScope } from '../../account/src/scope-descriptions.ts';
import { Value } from 'typebox/value';
import { feedCard, type FeedItem } from '../src/modules/feed/contract.ts';
import { collapseWorkCards, matchesFeedInterest } from '../src/modules/feed/read.ts';

test('G282: best is monotone in votes, decays with time, and its seek key preserves the exact order', () => {
  const time = Date.UTC(2026, 8, 28), now = time + FEED_DECAY_MS;
  for (const score of [-100, -2, -1, 0, 1, 2, 100]) {
    expect(bestScore(score + 1, time, now)).toBeGreaterThan(bestScore(score, time, now));
    expect(bestScore(score, time, now + FEED_DECAY_MS)).toBeCloseTo(bestScore(score, time, now) - 1, 8);
  }
  expect(bestKey(9, time)).toBeCloseTo(bestKey(0, time + FEED_DECAY_MS), 8);
  const items = [-4, 0, 1, 9, 30].map((score, i) => ({ score, time: time - i * 600_000 }));
  expect([...items].sort((a, b) => bestKey(b.score, b.time) - bestKey(a.score, a.time)))
    .toEqual([...items].sort((a, b) => bestScore(b.score, b.time, now) - bestScore(a.score, a.time, now)));
  expect(() => bestKey(0.5, time)).toThrow();
  expect(() => bestKey(0, Number.NaN)).toThrow();
});

test('G282: activity time uses UUIDv7 creation or explicitly identifies a legacy relay time', () => {
  const id = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
  const fallback = new Date(0);
  const time = activityTime(id, fallback);
  expect(time.basis).toBe('revision');
  expect(Math.abs(time.time.getTime() - Date.now())).toBeLessThan(1000);
  expect(activityTime('https://rezics.com/id/00000000-0000-4000-8000-000000000001', fallback))
    .toEqual({ time: fallback, basis: 'relay' });
});

test('G282: feed cursors bind filters, reader, votes/follows revision and graph cut; tampering fails closed', () => {
  const position = { dataEpoch: 'epoch', sequence: '42' };
  const binding = ['feed', 'revision', 'following', 'best', ['en'], 'person-a'];
  const cursor = encodeReadCursor(binding, position, 'item', '123.75');
  expect(decodeReadCursor(cursor, binding, position)).toMatchObject({ after: 'item', order: '123.75' });
  for (const changed of [['feed', 'revision-2', ...binding.slice(2)], [...binding.slice(0, -1), 'person-b']]) {
    expect(() => decodeReadCursor(cursor, changed, position)).toThrow(WorkReadInvalid);
  }
  expect(() => decodeReadCursor(cursor, binding, { ...position, sequence: '43' })).toThrow(WorkReadMoved);
  const altered = Buffer.from(cursor, 'base64url');
  altered[20] = altered[20]! ^ 1;
  expect(() => decodeReadCursor(altered.toString('base64url'), binding, position)).toThrow(WorkReadInvalid);
});

test('G282: feed, follows and votes expose concrete card and receipt types to web consumers', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const consume = async () => {
    const feed = await client.v1.feed.get({ query: { scope: 'all', kinds: ['work', 'reply'],
      contentLanguages: ['en', 'zh-Hans'], sort: 'best' } });
    const name: string | undefined = feed.data?.items[0]?.actor.name;
    const vote: -1 | 0 | 1 | undefined = feed.data?.items[0]?.vote;
    const following = await client.v1.me.follows.get({ query: { actingSubject: agent, kind: 'realm' } });
    const icon: string | undefined = following.data?.items[0]?.icon?.kind;
    const saved = await client.v1.follows.post({ profile: 'follow-command-v1', target: agent,
      kind: 'agent', actingSubject: agent, following: true, expectedRevision: null });
    const revision: string | undefined = saved.data?.revision;
    return { name, vote, icon, revision };
  };
  expect(consume).toBeFunction();
});

test('G282: each home OAuth ceiling explains its concrete consent in both Account languages', () => {
  expect(describeScope('follow:read').description).toEqual({
    en: 'See the communities, works and people you follow', 'zh-CN': '查看你关注的社区、作品和用户' });
  expect(describeScope('follow:write').description.en).toContain('Follow or unfollow');
  expect(describeScope('feed:vote').description.en).toContain('Cast, change or remove');
  expect(describeScope('feed:vote').description['zh-CN']).toContain('撤回');
});

test('G282: versioned Best normalizes Realm engagement, uses 24h decay and Top preserves net votes', () => {
  expect(FEED_DECAY_MS).toBe(86_400_000);
  expect(FEED_RANKING).toEqual({ version: 'home-best-v1', decayHours: 24, candidatePool: 256,
    normalization: 'realm-percentile-in-candidate-pool', signals: { upvote: 1, downvote: -1 }, diversityWindow: 10, realmCap: 3, thinFollowing: 3 });
  const candidates = [
    { id: 'large-1', realm: 'large', score: 9, time: 0 },
    { id: 'large-2', realm: 'large', score: 99, time: 0 },
    { id: 'small', realm: 'small', score: 9, time: 0 },
    { id: 'negative', realm: 'large', score: -1, time: 0 },
  ];
  expect(rankCandidates(candidates, 'best').map(item => item.id)).toEqual(['small', 'large-2', 'large-1', 'negative']);
  const ranks = rankCandidates(candidates, 'best');
  expect(ranks[0]!.rank).toBe(1);
  expect(ranks[2]!.rank).toBeCloseTo(2 / 3);
  expect(ranks[1]!.rank).toBe(1);
  expect(rankCandidates([{ id: 'old', realm: null, score: 9, time: 0 },
    { id: 'recent', realm: null, score: 1, time: FEED_DECAY_MS }], 'best')[0]!.id).toBe('recent');
  expect(rankCandidates([{ id: 'old', realm: null, score: 9, time: 0 },
    { id: 'recent', realm: null, score: 1, time: FEED_DECAY_MS }], 'top')[0]!.id).toBe('old');
});

test('G282: diversity holds for every sliding ten across page boundaries and exempts global cards', () => {
  const emitted: (string | null)[] = [];
  for (const realm of ['a', 'a', 'a', 'a', null, 'b', 'b', 'b', 'c', 'c', 'c', 'a', 'a', 'a', 'a', 'b', 'c']) {
    if (diversityAllows(realm, emitted.slice(-9))) emitted.push(realm);
  }
  for (let index = 0; index < emitted.length; index++) for (const realm of ['a', 'b', 'c']) {
    expect(emitted.slice(index, index + 10).filter(item => item === realm).length).toBeLessThanOrEqual(3);
  }
  expect(diversityAllows('a', ['a', 'a', 'a'])).toBe(false);
  expect(diversityAllows(null, Array(9).fill(null))).toBe(true);
});

test('G282: recommendations require thin Following and never enter Following New', () => {
  for (const count of [0, 1, 2, 3, 20]) expect(recommendationAllowed('following', 'new', count)).toBe(false);
  expect(recommendationAllowed('following', 'best', 2)).toBe(true);
  expect(recommendationAllowed('following', 'best', 3)).toBe(false);
  expect(recommendationAllowed('following', 'top', 0)).toBe(false);
  expect(recommendationAllowed('all', 'new', 0)).toBe(true);
});

test('G324: review cards require a Work interest and keep withheld spoiler text absent', () => {
  const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const source = { kind: 'review' as const, work };
  const kinds = new Map([[work, ['books' as const]]]);
  expect(matchesFeedInterest(source, ['books'], kinds)).toBe(true);
  expect(matchesFeedInterest(source, ['software'], kinds)).toBe(false);
  expect(matchesFeedInterest(source, ['discussions'], kinds)).toBe(false);
  const card = { kind: 'review', review: '00000000-0000-4000-8000-000000000002',
    rating: 4, scale: 5, spoiler: true, helpfulCount: 3, opening: null };
  expect(Value.Check(feedCard, card)).toBe(true);
  expect(Value.Check(feedCard, { ...card, opening: 'a'.repeat(401) })).toBe(false);
});

test('G324: a pick keeps the curator and combines the Work creation reasons once', () => {
  const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const creator = { id: 'creator', name: 'Creator', handle: 'creator' };
  const curator = { id: 'curator', name: 'Curator', handle: 'curator' };
  const added = { id: 'added', kind: 'added', actor: creator, target: { work }, realm: null,
    reason: { kind: 'recommended', basis: 'all' }, reasons: [{ kind: 'added-to-rezics', actor: creator.id }] } as FeedItem;
  const pick = { id: 'pick', kind: 'adoption', actor: curator, target: { work }, realm: { id: realm },
    reason: { kind: 'followed', target: realm, targetKind: 'realm' },
    reasons: [{ kind: 'realm-pick', realm, curator: curator.id }] } as FeedItem;
  const [card] = collapseWorkCards([added, pick]);
  expect(card?.id).toBe('pick');
  expect(card?.actor).toEqual(curator);
  expect(card?.reasons).toEqual([pick.reasons[0], added.reasons[0]]);
  expect(card?.reason.kind).toBe('followed');
  expect(collapseWorkCards([pick, pick])).toHaveLength(1);
});
