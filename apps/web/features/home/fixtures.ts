import { NOW, realms, storyId } from '../feed/fixtures.ts';
import type { ContinueItem, SuggestedFollow } from '../feed/types.ts';
import type { Community } from '../shell/communities.ts';
import type { RailData } from './rail.tsx';

// Story data for Home: a reader's Continue strip, communities and the rail.

const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const, basis: 'requested' as const });
const cover = (key: string) => ({ kind: 'fallback' as const, policy: 'avatar-fallback-v1', key, resourceType: 'work' });
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

export const continueItems: ContinueItem[] = [
  { work: storyId(61, 'cccc'), title: name('雨夜书店', 'zh-Hans'), cover: cover('rain'), source: 'reading',
    lastPosition: { occurrence: storyId(611, 'dddd'), position: null, completed: true, updatedAt: ago(20) },
    nextUnread: { occurrence: storyId(612, 'dddd'), title: '第三章 最后一班车', href: `/w/${storyId(61, 'cccc').slice(-36)}/read/${storyId(612, 'dddd').slice(-36)}` },
    unreadCount: { value: 3, kind: 'exact' }, updatedAt: ago(2) },
  { work: storyId(62, 'cccc'), title: name('The Last Lantern'), cover: cover('lantern'), source: 'followed',
    lastPosition: null, nextUnread: { occurrence: storyId(621, 'dddd'), title: 'Chapter 58 · The Siege',
      href: `/w/${storyId(62, 'cccc').slice(-36)}/read/${storyId(621, 'dddd').slice(-36)}` },
    unreadCount: { value: 20, kind: 'lower-bound' }, updatedAt: ago(5) },
  { work: storyId(63, 'cccc'), title: name('Middlemarch'), cover: cover('middlemarch'), source: 'reading',
    lastPosition: { occurrence: storyId(631, 'dddd'), position: null, completed: false, updatedAt: ago(30) },
    nextUnread: { occurrence: storyId(632, 'dddd'), title: null,
      href: `/w/${storyId(63, 'cccc').slice(-36)}/read/${storyId(632, 'dddd').slice(-36)}` },
    unreadCount: { value: 1, kind: 'exact' }, updatedAt: ago(30) },
];

const community = (id: string, label: string, href: string, activity: Community['activity']): Community =>
  ({ id, kind: 'realm', name: label, language: 'en', icon: { kind: 'fallback', key: label }, href, activity });

export const followedCommunities = {
  realms: [community(realms.fiction.id, realms.fiction.name.value, `/r/${realms.fiction.id.slice(-36)}`, 'new'),
    community(realms.classics.id, realms.classics.name.value, `/r/${realms.classics.id.slice(-36)}`, 'none'),
    community(realms.kitchen.id, realms.kitchen.name.value, `/r/${realms.kitchen.id.slice(-36)}`, 'new')],
  zones: [], complete: true,
};

export const officialZones: Community[] = [
  { ...community(storyId(951, 'aaaa'), 'Fiction · 小说', '/r/fiction', 'unknown'), kind: 'zone' },
  { ...community(storyId(952, 'aaaa'), 'Books · 图书', '/r/books', 'unknown'), kind: 'zone' },
  { ...community(storyId(953, 'aaaa'), 'Mods · 模组', '/r/mods', 'unknown'), kind: 'zone' },
  { ...community(storyId(954, 'aaaa'), 'AI Workshop · AI 工作坊', '/r/ai-workshop', 'unknown'), kind: 'zone' },
];

export const suggestions: SuggestedFollow[] = [
  { id: realms.mods.id, kind: 'realm', realm: realms.mods.id, name: realms.mods.name, icon: realms.mods.icon,
    membership: { count: { kind: 'exact', value: 12_480, revision: '1' } }, reason: { kind: 'matching-kind', interest: 'software' },
    sampleWorks: [{ id: storyId(71, 'cccc'), title: name('Crop Planner'), cover: cover('crop') }] },
  { id: storyId(955, 'aaaa'), kind: 'zone', realm: storyId(956, 'aaaa'), name: name('Fiction · 小说'), icon: cover('fiction-zone'),
    membership: { count: { kind: 'estimated', value: 48_000 } }, reason: { kind: 'official', interest: null },
    sampleWorks: [{ id: storyId(72, 'cccc'), title: name('雨夜书店', 'zh-Hans'), cover: cover('rain') },
      { id: storyId(73, 'cccc'), title: name('The Last Lantern'), cover: cover('lantern') }] },
  { id: realms.classics.id, kind: 'realm', realm: realms.classics.id, name: realms.classics.name, icon: realms.classics.icon,
    membership: { count: { kind: 'unknown', value: null } }, reason: { kind: 'popular', interest: null }, sampleWorks: [] },
];

const trend = (n: number, title: string, realm: typeof followedCommunities.realms[number], language = 'en') => ({
  item: { work: storyId(n, 'cccc'), realm: realm.id, title: name(title, language), cover: cover(`trend-${n}`), rank: n - 80,
    reason: 'growth-in-realm' as const }, realm });

export const railData: RailData = {
  trending: { scope: 'followed', items: [
    trend(81, '雨夜书店', followedCommunities.realms[0]!, 'zh-Hans'),
    trend(82, 'Middlemarch', followedCommunities.realms[1]!),
    trend(83, '三国演义', followedCommunities.realms[0]!, 'zh-Hans'),
    trend(84, 'Weekend buttermilk pancakes', followedCommunities.realms[2]!),
  ] },
  suggestions,
  moderated: [{ realm: realms.classics.id, name: realms.classics.name.value, open: 8, more: false,
    href: `/manage/r/${realms.classics.id.slice(-36)}` },
  { realm: realms.fiction.id, name: realms.fiction.name.value, open: 20, more: true, href: '/manage/r/fiction' }],
  ranking: { version: 'home-best-v1', decayHours: 24, candidatePool: 256,
    normalization: 'realm-percentile-in-candidate-pool', signals: { upvote: 1, downvote: -1 }, diversityWindow: 10,
    realmCap: 3, thinFollowing: 3 },
};
