import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { loadSubjectPage, SubjectPage, type SubjectActionsInput } from '../src/features/pages/subject.tsx';

const messages = {
  unknown: 'Unknown',
  none: 'None',
  unlabelled: 'Untitled',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
};
const kokoro = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';

async function kokoroPage() {
  const client = createKernelClient('https://kernel.invalid', { fetch: createFakeKernelFetch(fixtures as never) });
  const loaded = await loadSubjectPage(client, kokoro);
  if (loaded.kind !== 'page') throw new Error('expected the subject page');
  return loaded.page;
}

function subjectHeader(html: string): string {
  const marker = 'data-slot="subject-header"';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error('subject header missing');
  const start = html.lastIndexOf('<div', markerIndex);
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, tags.lastIndex);
  }
  throw new Error('subject header did not close');
}

test('the site renders its subject controls after the primary heading inside SubjectHeader', async () => {
  const page = await kokoroPage();
  const inputs: SubjectActionsInput[] = [];
  const actions = (subject: SubjectActionsInput) => {
    inputs.push(subject);
    return createElement('button', { type: 'button', 'data-test': 'collect' }, 'Add to collection');
  };
  const html = renderToString(createElement(SubjectPage, { page, locale: 'en', messages, actions }));
  expect(inputs).toEqual([{ id: kokoro, type: 'schema:Book', locale: 'en' }]);
  expect(html.match(/data-test="collect"/g)).toHaveLength(1);
  const header = subjectHeader(html);
  const heading = header.indexOf('<h1');
  expect(heading).toBeGreaterThan(-1);
  expect(header.indexOf('data-test="collect"')).toBeGreaterThan(heading);
});

test('without site controls the actions slot leaves no markup', async () => {
  const page = await kokoroPage();
  const html = renderToString(createElement(SubjectPage, { page, locale: 'en', messages }));
  expect(html).not.toContain('data-slot="actions"');
  expect(html).toContain('<h1');
});
