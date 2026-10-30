import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { createRecordedKernelFetch, type KernelRecording } from '../src/kernel/fake.ts';
import home from '../src/kernel/recorded/home-page.json';
import { loadRoutePage, RoutePage } from '../src/features/pages/route.tsx';

const messages = {
  unknown: '알 수 없음',
  none: '없음',
  unlabelled: '이름 없음',
  sources: '출처',
  aliases: '다른 이름',
  search: '검색',
};

test('the recorded home read replays as the kernel answered it', async () => {
  expect(home).toMatchObject({ status: 200, template: { scope: 'route', key: '/' } });
  expect((home as { profile: string }).profile).toMatch(/^sha256:[0-9a-f]{64}$/);
  const client = createKernelClient('https://kernel.invalid', {
    fetch: createRecordedKernelFetch({ 'home-page': home as KernelRecording }),
  });
  const loaded = await loadRoutePage(client, '/');
  if (loaded.kind !== 'page') throw new Error('expected the recorded home');
  const html = renderToString(createElement(RoutePage, { page: loaded.page, locale: 'ko', messages }));
  expect(html).not.toMatch(/<form/);
  expect(html).not.toMatch(/<input[^>]*name="q"/);
  expect(html).toContain('href="/ko/search?type=schema%3ABook"');
  expect(html).not.toContain('data-slot="cover-card-secondary"');
  const story = await Bun.file(new URL('../src/stories/home.stories.tsx', import.meta.url)).text();
  expect(story).toContain('pagePaths.home');
});
