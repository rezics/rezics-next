import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { createRecordedKernelFetch, type KernelRecording } from '../src/kernel/fake.ts';
import page from '../src/kernel/recorded/subject-page.json';
import missing from '../src/kernel/recorded/missing-subject-page.json';
import subject from '../src/kernel/recorded/subject.json';
import { loadSubjectPage, SubjectPage } from '../src/features/pages/subject.tsx';

const recordings: Record<string, KernelRecording> = {
  'subject-page': page as KernelRecording,
  'missing-subject-page': missing as KernelRecording,
  subject: subject as KernelRecording,
};
const client = createKernelClient('https://kernel.invalid', { fetch: createRecordedKernelFetch(recordings) });
const id = (subject as { subject: { id: string } }).subject.id;
const messages = { unknown: 'Unknown', none: 'None', unlabelled: 'Unlabelled', sources: 'Sources', aliases: 'Aliases' };

test('the recorded page read replays as the kernel answered it', async () => {
  expect(page).toMatchObject({ status: 200, subject: id, template: { scope: expect.any(String) } });
  expect((page as { profile: string }).profile).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(missing).toMatchObject({ status: 404, code: 'not_found' });
  const loaded = await loadSubjectPage(client, id);
  expect(loaded.kind).toBe('page');
  expect(await loadSubjectPage(client, '00000000-0000-4000-8000-000000000000')).toEqual({ kind: 'missing' });
});

test('the subject story renders the real subject page', async () => {
  const loaded = await loadSubjectPage(client, id, undefined, 'fr');
  if (loaded.kind !== 'page') throw new Error('expected the recorded page');
  const html = renderToString(createElement(SubjectPage, { page: loaded.page, locale: 'fr', messages }));
  expect(html).toMatch(/<h1[^>]*>Le Petit Prince<\/h1>/);
  expect(html).toContain('application/ld+json');
  const story = await Bun.file(new URL('../src/stories/subject.stories.tsx', import.meta.url)).text();
  expect(story).toContain('pagePaths.subject');
});
