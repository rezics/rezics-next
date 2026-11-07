import { afterEach, expect, test } from 'bun:test';
import { subjectBody } from '../src/features/pages/subject-read';
import type { SubjectPageData } from '../src/features/pages/page-model';
import { createStoryRecordedKernelFetch, type KernelRecording } from '../src/kernel/fake.ts';
import { routes as pageRoutes } from '../src/kernel/fake/pages.ts';
import { routes as sourceRoutes } from '../src/kernel/fake/subject-sources.ts';
import { requestLanguages } from '../src/kernel/languages.ts';
import subjectPage from '../src/kernel/recorded/subject-page.json';
import subject from '../src/kernel/recorded/subject.json';

const storyGlobal = globalThis as typeof globalThis & { __rezicsStoryContext?: { url?: string } };
const previousContext = storyGlobal.__rezicsStoryContext;
afterEach(() => {
  if (previousContext === undefined) delete storyGlobal.__rezicsStoryContext;
  else storyGlobal.__rezicsStoryContext = previousContext;
});

function request(target: unknown, languages: string[] = ['en']) {
  return new Request('https://kernel.local/v1/pages:read', {
    method: 'POST',
    body: JSON.stringify({ target, languages }),
  });
}

test.each(['all', 'empty'] as const)('recorded %s Sources selection retains every locale', async (scenario) => {
  storyGlobal.__rezicsStoryContext = { url: `/subjects/${subjectPage.subject}?sourceRecords=${scenario}` };
  const fetcher = createStoryRecordedKernelFetch();
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    for (const view of [undefined, 'overview']) {
      const response = await fetcher(
        request({ subject: subjectPage.subject, ...(view ? { view } : {}) }, requestLanguages(locale)),
      );
      expect(response.status).toBe(200);
      const read = subjectBody((await response.json()) as SubjectPageData);
      expect(read).toBeDefined();
      const records = Reflect.get(read!.subject, 'sourceRecords') as unknown[];
      expect(records).toHaveLength(scenario === 'all' ? 6 : 0);
      expect(read!.subject.labels).toEqual(subject.subject.labels);
      expect(read!.summary?.cover?.credit?.rightsHolder).toBe('REZICS fixtures');
      if (scenario === 'all') {
        expect(records).toContainEqual({
          name: 'Matching statement reference',
          url: 'https://archive.example.test/little-prince',
        });
        expect(read!.subject.statements['schema:keywords']?.[0]?.references).toEqual([
          {
            parts: [
              {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value', content: 'https://archive.example.test/little-prince' },
              },
            ],
          },
        ]);
      }
    }
  }
});

test('Sources selection preserves generic page fallback and declines other targets and selectors', async () => {
  const recordings: Record<string, KernelRecording> = {
    'subject-page': { status: 200, subject: subjectPage.subject, marker: 'ordinary subject' },
    'home-page': { status: 200, marker: 'ordinary home' },
    'agent-page': { status: 200, handle: 'reader', marker: 'ordinary agent' },
    'missing-subject-page': { status: 404, marker: 'missing subject' },
  };
  const cases: [string, unknown, KernelRecording | undefined][] = [
    ['', { subject: subjectPage.subject }, undefined],
    ['?sourceRecords=other', { subject: subjectPage.subject }, undefined],
    ['?sourceRecords=all', { route: '/' }, recordings['home-page']],
    ['?sourceRecords=empty', { account: 'reader' }, recordings['agent-page']],
    ['?sourceRecords=all', { subject: '00000000-0000-4000-8000-000000000000' }, recordings['missing-subject-page']],
    ['?sourceRecords=empty', { subject: 'another-subject' }, undefined],
    ['?sourceRecords=all', { subject: subjectPage.subject, view: 'details' }, undefined],
    ['?sourceRecords=empty', null, undefined],
  ];
  for (const [query, target, expected] of cases) {
    storyGlobal.__rezicsStoryContext = { url: `/subjects/${subjectPage.subject}${query}` };
    const context = { request: request(target), recordings, match: null };
    expect(await pageRoutes[0]!.story!(context)).toEqual(expected);
    expect(await sourceRoutes[0]!.story!(context)).toBeUndefined();
  }
  storyGlobal.__rezicsStoryContext = { url: `/subjects/${subjectPage.subject}?sourceRecords=all` };
  expect(
    await pageRoutes[0]!.story!({ request: request({ subject: subjectPage.subject }, []), recordings, match: null }),
  ).toBeUndefined();
});
