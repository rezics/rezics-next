import { afterAll, expect, test } from 'bun:test';
import { requestForStory, setStoryRequestContext } from '../.storybook/react-start';
import { env } from '../.storybook/cloudflare-workers';
import { prepareSession, sessionSubject, viewerCredential } from '../src/session/request';

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousContext = Object.getOwnPropertyDescriptor(globalThis, '__rezicsStoryContext');
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { location: new URL('https://storybook.test/iframe.html') },
});
afterAll(() => {
  for (const [key, previous] of [
    ['window', previousWindow],
    ['__rezicsStoryContext', previousContext],
  ] as const) {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('cloned private story reads retain their captured session and prepare distinct request identities', async () => {
  setStoryRequestContext({ visitor: 'Signed In', url: '/ja/library/copies?cursor=opaque%2Bpage' });
  const request = requestForStory();
  await prepareSession(request, env);
  setStoryRequestContext({ visitor: 'Signed Out', url: '/en/library' });
  const clone = request.clone().clone();
  expect(clone).not.toBe(request);
  expect(clone.url).toBe(request.url);
  expect(clone.headers.get('cookie')).toBe(request.headers.get('cookie'));
  expect(clone.headers.get('host')).toBe('storybook.test');
  expect(sessionSubject(clone)).toBeUndefined();
  await prepareSession(clone, env);
  expect(sessionSubject(clone)).toBe('story-viewer');
  expect(viewerCredential(clone)).toBe('Bearer recorded-story-token');
});

test('anonymous and credentials-omitted story clones never acquire the later visitor session', async () => {
  setStoryRequestContext({ visitor: 'Signed Out', url: '/en/library/labels' });
  const anonymous = requestForStory();
  setStoryRequestContext({ visitor: 'Signed In', url: '/en/library/labels' });
  const omitted = requestForStory(undefined, { credentials: 'omit' });
  for (const request of [anonymous.clone(), omitted.clone()]) {
    expect(request.headers.get('cookie')).toBeNull();
    await prepareSession(request, env);
    expect(sessionSubject(request)).toBeUndefined();
    expect(viewerCredential(request)).toBeNull();
  }
});
