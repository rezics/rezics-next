import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { slug } from '@rezics/definitions/slug';
import platform from '@rezics/composition/profiles/platform.json';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { loadSubjectPage, SubjectPage, subjectPageTitle } from '../src/features/pages/subject.tsx';
import type { PageMessages } from '../src/features/pages/data.tsx';

const kokoro = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const soseki = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02';
const taketori = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e03';
const shortStory = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e05';
const mergedGenre = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e0a';
const mergedId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e08';
const missingId = '00000000-0000-4000-8000-000000000000';
const sent: string[] = [];
const local = createFakeKernelFetch(fixtures as never);
const client = createKernelClient('https://kernel.invalid', {
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === 'POST' ? ` ${await request.clone().text()}` : '';
    sent.push(`${request.method} ${new URL(request.url).pathname}${body}`);
    return local(request);
  }) as typeof fetch,
});
const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled subject',
  sources: 'Sources',
  aliases: 'Also known as',
};
const loaded = async (id: string) => {
  const result = await loadSubjectPage(client, id);
  if (result.kind !== 'page') throw new Error(`expected a page, got ${result.kind}`);
  return result.page;
};

test('a subject page is one page read rendered from its template', async () => {
  sent.length = 0;
  const page = await loaded(kokoro);
  expect(sent).toEqual([`POST /v1/pages:read ${JSON.stringify({ target: { subject: kokoro }, languages: ['en'] })}`]);
  expect(page.subject).toBe(kokoro);
  expect(page.template).toEqual({ scope: 'base', key: 'schema:CreativeWork' });
  expect(page.document).toEqual(
    (platform.bases.find(({ base }) => base === 'schema:CreativeWork') as { views: { overview: unknown } }).views
      .overview,
  );
  expect(subjectPageTitle(page, 'en')).toBe('Kokoro');
  expect(subjectPageTitle(page, 'ja')).toBe('こころ');
  const html = renderToString(createElement(SubjectPage, { page, locale: 'en', messages }));
  expect(html).toMatch(/<h1[^>]*>Kokoro<\/h1>/);
  expect(html).toMatch(new RegExp(`href="/en/subjects/${soseki}/${slug('Natsume Sōseki')}"[^>]*>Natsume Sōseki</a>`));
  const script = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html);
  expect(script).not.toBeNull();
  expect(JSON.parse(script![1]!)).toMatchObject({ '@context': 'https://schema.org', '@type': 'Book', name: 'Kokoro' });
  const tale = renderToString(createElement(SubjectPage, { page: await loaded(taketori), locale: 'en', messages }));
  expect(tale).toContain(`href="/en/subjects/${shortStory}/${slug('short story')}"`);
  expect(tale).not.toContain(`/subjects/${mergedGenre}`);
  const person = await loaded(soseki);
  expect(person.template).toEqual({ scope: 'base', key: 'schema:CreativeWork' });
});

test('a subject page requests and renders the reader language before English', async () => {
  sent.length = 0;
  const page = await loadSubjectPage(client, kokoro, undefined, 'ja');
  if (page.kind !== 'page') throw new Error(`expected a page, got ${page.kind}`);
  expect(sent).toEqual([`POST /v1/pages:read ${JSON.stringify({ target: { subject: kokoro }, languages: ['ja'] })}`]);
  expect(subjectPageTitle(page.page, 'ja')).toBe('こころ');
  const html = renderToString(createElement(SubjectPage, { page: page.page, locale: 'ja', messages }));
  expect(html).toMatch(/<h1[^>]*>こころ<\/h1>/);
});

test('merged and missing subjects are told apart', async () => {
  expect(await loadSubjectPage(client, mergedId)).toEqual({ kind: 'redirect', id: kokoro });
  expect(await loadSubjectPage(client, missingId)).toEqual({ kind: 'missing' });
  sent.length = 0;
  expect(await loadSubjectPage(client, 'not-a-uuid')).toEqual({ kind: 'missing' });
  expect(sent).toEqual([]);
});
