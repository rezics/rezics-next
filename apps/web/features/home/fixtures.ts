import { communityHref } from '../feed/discussion.ts';
import { resourceHref } from '../address/path.ts';
import { NOW, realms, storyId } from '../feed/fixtures.ts';
import type { ContinueItem, SuggestedFollow } from '../feed/types.ts';
import type { Community } from '../shell/communities.ts';
import type { RailData } from './rail.tsx';

// Story data for Home: a reader's Continue strip, communities and the rail.

const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const, basis: 'requested' as const });
const cover = (key: string) => ({ kind: 'fallback' as const, policy: 'avatar-fallback-v1', key, resourceType: 'work' });
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const book = 'https://schema.org/Book';

export const continueItems: ContinueItem[] = [
  { work: storyId(61, 'cccc'), title: name('雨夜书店', 'zh-Hans'), cover: cover('rain'), types: [book], source: 'reading',
    lastPosition: { occurrence: storyId(611, 'dddd'), position: null, completed: true, updatedAt: ago(20) },
    nextUnread: { occurrence: storyId(612, 'dddd'), title: '第三章 最后一班车', href: `${resourceHref('/w/', storyId(61, 'cccc'))}/read/${storyId(612, 'dddd').slice(-36)}` },
    unreadCount: { value: 3, kind: 'exact' }, updatedAt: ago(2) },
  { work: storyId(62, 'cccc'), title: name('The Last Lantern'), cover: cover('lantern'), types: [book], source: 'followed',
    lastPosition: null, nextUnread: { occurrence: storyId(621, 'dddd'), title: 'Chapter 58 · The Siege',
      href: `${resourceHref('/w/', storyId(62, 'cccc'))}/read/${storyId(621, 'dddd').slice(-36)}` },
    unreadCount: { value: 20, kind: 'lower-bound' }, updatedAt: ago(5) },
  { work: storyId(63, 'cccc'), title: name('Middlemarch'), cover: cover('middlemarch'), types: [book], source: 'reading',
    lastPosition: { occurrence: storyId(631, 'dddd'), position: null, completed: false, updatedAt: ago(30) },
    nextUnread: { occurrence: storyId(632, 'dddd'), title: null,
      href: `${resourceHref('/w/', storyId(63, 'cccc'))}/read/${storyId(632, 'dddd').slice(-36)}` },
    unreadCount: { value: 1, kind: 'exact' }, updatedAt: ago(30) },
];

const community = (id: string, label: string, href: string, activity: Community['activity']): Community =>
  ({ id, kind: 'realm', name: label, language: 'en', icon: { kind: 'fallback', key: label }, href, activity });

export const followedCommunities = {
  realms: [community(realms.fiction.id, realms.fiction.name.value, communityHref(realms.fiction.id), 'new'),
    community(realms.classics.id, realms.classics.name.value, communityHref(realms.classics.id), 'none'),
    community(realms.kitchen.id, realms.kitchen.name.value, communityHref(realms.kitchen.id), 'new')],
  zones: [], complete: true,
};

export const officialZones: Community[] = [
  { ...community(storyId(951, 'aaaa'), 'Fiction · 小说', communityHref(storyId(951, 'aaaa'), 'fiction'), 'unknown'), kind: 'zone' },
  { ...community(storyId(952, 'aaaa'), 'Books · 图书', communityHref(storyId(952, 'aaaa'), 'books'), 'unknown'), kind: 'zone' },
  { ...community(storyId(953, 'aaaa'), 'Mods · 模组', communityHref(storyId(953, 'aaaa'), 'mods'), 'unknown'), kind: 'zone' },
  { ...community(storyId(954, 'aaaa'), 'AI Workshop · AI 工作坊', communityHref(storyId(954, 'aaaa'), 'ai-workshop'), 'unknown'), kind: 'zone' },
];

export const suggestions: SuggestedFollow[] = [
  { id: realms.mods.id, kind: 'realm', realm: realms.mods.id, name: realms.mods.name, icon: realms.mods.icon,
    membership: { count: { kind: 'exact', value: 12_480, revision: '1' } },
    reason: { kind: 'matching-concept', concept: { id: storyId(311, 'eeee'), name: name('Farming sims') } },
    sampleWorks: [{ id: storyId(71, 'cccc'), title: name('Crop Planner'), cover: cover('crop') }] },
  { id: storyId(955, 'aaaa'), kind: 'zone', realm: storyId(956, 'aaaa'), name: name('Fiction · 小说'), icon: cover('fiction-zone'),
    membership: { count: { kind: 'estimated', value: 48_000 } }, reason: { kind: 'popular', language: 'zh-Hans' },
    sampleWorks: [{ id: storyId(72, 'cccc'), title: name('雨夜书店', 'zh-Hans'), cover: cover('rain') },
      { id: storyId(73, 'cccc'), title: name('The Last Lantern'), cover: cover('lantern') }] },
  { id: realms.classics.id, kind: 'realm', realm: realms.classics.id, name: realms.classics.name, icon: realms.classics.icon,
    membership: { count: { kind: 'unknown', value: null } }, reason: { kind: 'popular' }, sampleWorks: [] },
];

const trend = (n: number, title: string, realm: typeof followedCommunities.realms[number], language = 'en',
  types = [book]) => ({
  item: { work: storyId(n, 'cccc'), realm: realm.id, title: name(title, language), cover: cover(`trend-${n}`), types,
    rank: n - 80, reason: 'growth-in-realm' as const }, realm });

export const railData: RailData = {
  trending: { scope: 'followed', items: [
    trend(81, '雨夜书店', followedCommunities.realms[0]!, 'zh-Hans'),
    trend(82, 'Middlemarch', followedCommunities.realms[1]!),
    trend(83, '三国演义', followedCommunities.realms[0]!, 'zh-Hans'),
    trend(84, 'Weekend buttermilk pancakes', followedCommunities.realms[2]!, 'en', ['https://schema.org/Recipe']),
  ] },
  suggestions,
  moderated: [{ realm: realms.classics.id, name: realms.classics.name.value, open: 8, more: false,
    href: `/manage/r/${realms.classics.id.slice(-36)}` },
  { realm: realms.fiction.id, name: realms.fiction.name.value, open: 20, more: true, href: '/manage/r/fiction' }],
  ranking: { version: 'home-best-v1', decayHours: 24, candidatePool: 256,
    normalization: 'realm-percentile-in-candidate-pool', signals: { upvote: 1, downvote: -1 }, diversityWindow: 10,
    realmCap: 3, thinFollowing: 3 },
};
