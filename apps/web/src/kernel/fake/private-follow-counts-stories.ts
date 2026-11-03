import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

/** Story composition only. Native follow_count.target still owns management authority. */
export type PrivateFollowCountsStoryMode =
  | 'absent'
  | 'zero'
  | 'nonzero'
  | 'context'
  | 'denied'
  | 'unavailable'
  | 'loading';

export const privateFollowCountsStoryTarget = {
  targetType: 'collection' as const,
  targetId: '0192f3a0-6c1e-7b2a-9d4e-000000000021',
};

const privateHeaders = { 'cache-control': 'private, no-store' };
const targetPath = /^\/v1\/followCounts\/(subject|collection|space)\/([^/]+)$/;
let mode: PrivateFollowCountsStoryMode = 'absent';

export function setPrivateFollowCountsStoryMode(next: PrivateFollowCountsStoryMode): void {
  mode = next;
}

function recording(
  status: number,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = privateHeaders,
): KernelRecording {
  return { status, ...body, headers };
}

function answer(request: Request): KernelRecording | Promise<KernelRecording> {
  // Default 404 matches unsigned route stories: outgoing unavailable, contextual denied, no counts.
  if (mode === 'loading') return new Promise<KernelRecording>(() => {});
  const url = new URL(request.url);
  const outgoing = url.pathname === '/v1/followCounts/outgoing';
  if (mode === 'unavailable')
    return recording(503, { code: 'dependency_unavailable' }, { ...privateHeaders, 'retry-after': '7' });
  if (outgoing) {
    if (mode === 'absent') return recording(404, { code: 'not_found' });
    return recording(200, { followingCount: mode === 'zero' ? 0 : 24 });
  }
  const match = targetPath.exec(url.pathname);
  if (!match) return recording(404, { code: 'not_found' });
  if (mode === 'denied' || mode === 'absent') return recording(404, { code: 'not_found' });
  return recording(200, { targetType: match[1], targetId: decodeURIComponent(match[2]!), followerCount: 0 });
}

export const routes: FakeRoute[] = [
  { method: 'GET', path: '/v1/followCounts/outgoing', story: ({ request }) => answer(request) },
  { method: 'GET', path: targetPath, story: ({ request }) => answer(request) },
];
