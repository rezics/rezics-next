import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createKernelClient } from '@rezics/client';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import {
  privateFollowCountsStoryTarget as target,
  setPrivateFollowCountsStoryMode,
} from '../src/kernel/fake/private-follow-counts-stories';
import { followCountsSearch, readFollowCounts } from '../src/library/private-follow-counts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

afterEach(() => setPrivateFollowCountsStoryMode('absent'));

test('private follow-count page stories enter the signed-in route instead of injecting page props', () => {
  const story = source('../src/stories/library-private-follow-counts.stories.tsx');
  const route = source('../src/routes/library/follow-counts.tsx');
  expect(route).toContain('beforeLoad: requireSignedIn');
  expect(route).toContain('validateSearch: followCountsSearch');
  expect(story).toContain("title: 'Pages/Library/Private follow counts'");
  expect(story).toContain('<PageStory visitor="Signed In" path={path} />');
  expect(story).not.toContain('PrivateFollowCountsPageView');
  expect(story).not.toContain('PatternStory');
  expect(story).not.toMatch(/page=\{/);
  expect([...story.matchAll(/export const (\w+): Story =/g)].map((entry) => entry[1])).toEqual([
    'ReadyZero',
    'ReadyNonzero',
    'ContextualZero',
    'DeniedContext',
    'Unavailable',
    'Loading',
    'InvalidContext',
  ]);
  expect(story).toContain('mode="zero"');
  expect(story).toContain('mode="nonzero"');
  expect(story).toContain('mode="context"');
  expect(story).toContain('mode="denied"');
  expect(story).toContain('mode="unavailable"');
  expect(story).toContain('mode="loading"');
  expect(story).toContain(`path={contextPath}`);
  expect(story).toContain('?targetType=collection');
  expect(followCountsSearch({ targetType: 'collection' })).toEqual({ invalidContext: true });
});

test('story kernel follow-count responses keep private no-store counts, concealed denial and independent outgoing', async () => {
  const fetch = createStoryRecordedKernelFetch();
  const client = createKernelClient('http://kernel.local', { fetch });
  const authorization = 'Bearer story-transport';
  setPrivateFollowCountsStoryMode('zero');
  const zero = await fetch('http://kernel.local/v1/followCounts/outgoing');
  expect(zero.headers.get('cache-control')).toBe('private, no-store');
  expect(await readFollowCounts(client, authorization, {})).toEqual({
    context: {},
    outgoing: { state: 'ready', count: 0 },
    target: null,
  });
  setPrivateFollowCountsStoryMode('context');
  const contextual = await readFollowCounts(client, authorization, target);
  expect(contextual.outgoing).toEqual({ state: 'ready', count: 24 });
  expect(contextual.target).toEqual({ state: 'ready', count: 0 });
  setPrivateFollowCountsStoryMode('denied');
  const denied = await readFollowCounts(client, authorization, target);
  expect(denied.outgoing).toEqual({ state: 'ready', count: 24 });
  expect(denied.target).toEqual({ state: 'denied', status: 404, code: 'not_found' });
  expect(JSON.stringify(denied.target)).not.toContain('"count":');
  setPrivateFollowCountsStoryMode('unavailable');
  const unavailable = await readFollowCounts(client, authorization, {});
  expect(unavailable.outgoing).toMatchObject({ state: 'unavailable', status: 503, retryAfter: '7' });
  expect(unavailable.target).toBeNull();
  expect(JSON.stringify(unavailable)).not.toContain('"count":');
  setPrivateFollowCountsStoryMode('absent');
  const missing = await readFollowCounts(client, authorization, target);
  expect(missing.outgoing.state).toBe('unavailable');
  expect(missing.target?.state).toBe('denied');
  expect(JSON.stringify(missing)).not.toContain('"count":');
});
