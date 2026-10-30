import type { FakeRoute } from '../fake-modules.ts';
import followsRecording from '../recorded/library-follows.json';

export type LibraryFollowingStoryMode =
  | 'recorded'
  | 'none'
  | 'many'
  | 'unavailable'
  | 'error'
  | 'hidden'
  | 'unfollow-failure';

let mode: LibraryFollowingStoryMode = 'recorded';

export function setLibraryFollowingStoryMode(next: LibraryFollowingStoryMode): void {
  mode = next;
}

function list() {
  if (mode === 'unavailable')
    return { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' };
  if (mode === 'error')
    return { status: 500, type: 'https://rezics.com/problems/internal_error', code: 'internal_error' };
  const base = followsRecording.follows;
  if (mode === 'none') return { status: 200, follows: [], next: null };
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
    path: '/v1/follows',
    story: () => list(),
  },
  {
    method: 'DELETE',
    path: /^\/v1\/follows\/[^/]+$/,
    story: () =>
      mode === 'unfollow-failure'
        ? { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' }
        : { status: 204 },
  },
];
