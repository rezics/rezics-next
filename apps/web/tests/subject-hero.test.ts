import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createKernelClient } from '@rezics/client';
import { createRecordedKernelFetch } from '../src/kernel/fake.ts';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { loadSubjectPage } from '../src/features/pages/subject.tsx';

const root = new URL('../src/features/pages/', import.meta.url);
const source = async (name: string) => readFile(new URL(name, root), 'utf8');

test('subject hero facts use one two-column term/value list that contains long values', async () => {
  const data = await source('data.tsx');
  expect(data).toMatch(
    /<dl[^>]*data-slot="subject-aliases"[^>]*grid[^>]*grid-cols-\[minmax\(0,1fr\)_minmax\(0,3fr\)\]/,
  );
  expect(data).toMatch(/<dt[^>]*>[\s\S]*?<\/dt>[\s\S]*?<dd[^>]*min-w-0 break-words/);
});

test('spoiler control is an icon text button, outside subject values', async () => {
  const values = await source('values.tsx');
  expect(values).toMatch(/<CollapsibleTrigger[^>]*>[\s\S]*<Eye[^>]*>[\s\S]*\{label\}[\s\S]*<\/CollapsibleTrigger>/);
  expect(values).not.toMatch(/<dt[^>]*>[\s\S]*spoilerShow/);
});

test('reactions and the subject menu share a top-right row; library actions are grouped under the title', async () => {
  const [actions, data] = await Promise.all([source('subject-reactions-view.tsx'), source('data.tsx')]);
  expect(actions).toMatch(/data-slot="subject-header-actions"[\s\S]*?ThreadReactions[\s\S]*?PostActions/);
  expect(actions).toMatch(/data-slot="subject-library-actions"[\s\S]*?children/);
  expect(actions).toMatch(/className="[^"]*sm:col-start-2 sm:row-start-1"[^>]*data-slot="subject-header-actions"/);
  expect(actions).toMatch(/className="[^"]*sm:col-start-1 sm:row-start-2"[^>]*data-slot="subject-library-actions"/);
  expect(data).toMatch(/grid min-w-0 flex-1 grid-cols-1[^\"]*sm:grid-cols-\[minmax\(0,1fr\)_auto\]/);
  expect(data).toMatch(/\{options\.headerActions\}/);
});

test('overview sections share the shell heading and spacing classes', async () => {
  const overview = await source('overview.tsx');
  expect(overview.match(/className=\{headingClass\}/g)?.length).toBeGreaterThan(0);
  expect(overview.match(/className=\{sectionClass\}/g)?.length).toBeGreaterThan(0);
  expect(overview).toMatch(/sectionClass\s*=\s*['"]min-w-0 space-y-4/);
  expect(overview).not.toMatch(/sectionClass[^\n]*space-y-6/);
  expect(overview).toMatch(/className=\{`\$\{sectionClass\} border-t/);
});

test('cover credit is rendered only in Sources and the cover viewer', async () => {
  const [overview, subject] = await Promise.all([source('overview.tsx'), source('subject.tsx')]);
  const creditOccurrences = [overview, subject].join('\n').match(/rightsHolder/g) ?? [];
  expect(creditOccurrences).toHaveLength(1);
  expect(overview).toMatch(/data-slot="subject-sources"[\s\S]*?rightsHolder/);
});

test('the subject page keeps its base kernel request count', async () => {
  const requests: string[] = [];
  const fetchFake = createRecordedKernelFetch({ 'subject-page': recordedPage });
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return fetchFake(request);
    }) as typeof fetch,
  });

  const page = await loadSubjectPage(client, recordedPage.subject);

  expect(page.kind).toBe('page');
  expect(requests).toEqual(['POST /v1/pages:read']);
});
