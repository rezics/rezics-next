import type { FakeRoute } from '../fake-modules.ts';
import spaceRecording from '../recorded/space.json';
import followsRecording from '../recorded/library-follows.json';

export type LibraryFollowingStoryMode =
  | 'recorded'
  | 'none'
  | 'inactive-page'
  | 'last-follow'
  | 'many'
  | 'unavailable'
  | 'error'
  | 'hidden'
  | 'unfollow-failure'
  | 'reading-preparing'
  | 'reading-no-destination'
  | 'reading-unavailable'
  | 'reading-long'
  | 'reading-current-source';

let mode: LibraryFollowingStoryMode = 'recorded';
let observation = 0;

export function setLibraryFollowingStoryMode(next: LibraryFollowingStoryMode): void {
  mode = next;
  observation = 0;
}

function list() {
  if (mode === 'unavailable')
    return { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' };
  if (mode === 'error')
    return { status: 500, type: 'https://rezics.com/problems/internal_error', code: 'internal_error' };
  const base = followsRecording.follows;
  if (mode === 'reading-long' || mode === 'reading-current-source') {
    observation++;
    const label = mode === 'reading-long'
      ? '長い夜にゆっくり読む本を探している人たちのための、長い名前を持つ静かな読書コミュニティ '.repeat(3)
      : `Current community observation ${observation}`;
    return { status: 200, follows: base.map(follow => follow.targetType === 'space'
      ? { ...follow, target: { ...follow.target, label } } : follow), next: null };
  }
  if (mode === 'none') return { status: 200, follows: [], next: null };
  if (mode === 'inactive-page')
    return {
      status: 200,
      follows: base.map((follow) => ({ ...follow, state: 'unfollowed' as const })),
      next: 'next-page',
    };
  if (mode === 'last-follow') return { status: 200, follows: base.slice(-1), next: null };
  if (mode === 'hidden') {
    const hidden = base.map((follow, index) => (index < 2 ? { ...follow, target: null } : follow));
    return { status: 200, follows: hidden, next: null };
  }
  if (mode === 'many') {
    const follows = Array.from({ length: 12 }, (_, index) => {
      const source = base[index % base.length]!;
      const targetId = `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`;
      const target = { ...source.target, id: targetId, label: `Following item ${index + 1}` };
      return { ...source, targetId, target };
    });
    return { status: 200, follows, next: 'next-page' };
  }
  return structuredClone(followsRecording);
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: `/v1/spaces/${followsRecording.follows[0]!.targetId}`,
    story: () => {
      if (mode === 'reading-preparing') return new Promise(() => {});
      if (mode === 'reading-unavailable') return { status: 503, code: 'unavailable' };
      return { status: 200, space: { ...spaceRecording.space,
        spaceId: followsRecording.follows[0]!.targetId,
        ...(mode === 'reading-no-destination' ? { address: null, realmId: null } : {}),
      } };
    },
  },
  {
    method: 'GET',
    path: '/v1/follows',
    story: () => list(),
  },
  {
    method: 'DELETE',
    path: /^\/v1\/follows\/[^/]+$/,
    story: ({ request }) => {
      if (mode === 'unfollow-failure')
        return { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' };
      const page = list();
      const targetId = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1)!);
      const found = 'follows' in page ? page.follows.find((follow) => follow.targetId === targetId) : undefined;
      if (!found) return { status: 404, code: 'not_found' };
      const { target: _target, ...follow } = found;
      return { status: 200, follow: { ...follow, state: 'unfollowed' } };
    },
  },
];
