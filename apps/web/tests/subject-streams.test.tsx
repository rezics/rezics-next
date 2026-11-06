import { expect, test } from 'bun:test';
import { createElement } from 'react';
import {
  SubjectStreamDirectory,
  selectedStreamDocument,
  subjectStreamHref,
  type SubjectStreams,
} from '../src/features/pages/subject-streams';
import { renderSubject } from './helpers/subject-render';
import type { PageDocument } from '../src/features/pages/render';

const entries: SubjectStreams['entries'] = [
  { node: 'directors', property: 'schema:director', direction: 'forward' },
  { node: 'voice', property: 'wdt:P725', direction: 'forward' },
];
const document: PageDocument = {
  root: { props: {} },
  content: [
    {
      type: 'Stack',
      props: {
        id: 'roles',
        children: [
          { type: 'Heading', props: { id: 'heading', text: 'Credits', level: 2 } },
          {
            type: 'Credits',
            props: {
              id: 'directors',
              property: 'schema:director',
              direction: 'forward',
              title: { en: 'Directors', ja: '監督' },
              limit: 8,
              paged: true,
            },
          },
          {
            type: 'Credits',
            props: {
              id: 'voice',
              property: 'wdt:P725',
              direction: 'forward',
              title: { en: 'Voice actors', ja: '声優' },
              limit: 8,
              paged: true,
            },
          },
        ],
      },
    },
  ],
};

test('selecting a role retains population and return URLs and starts its first bounded window', () => {
  const href = subjectStreamHref(
    '/ja/subjects/work/title/credits?realm=r&via=%2Fja%2Fsearch%3Fq%3Dtest&node=directors&cursor=opaque&streamProperty=old&streamDirection=forward&history=old&focus=old',
    'voice',
  );
  const url = new URL(href, 'https://rezics.test');
  expect(url.pathname).toBe('/ja/subjects/work/title/credits');
  expect(url.searchParams.get('realm')).toBe('r');
  expect(url.searchParams.get('via')).toBe('/ja/search?q=test');
  expect(url.searchParams.get('node')).toBe('voice');
  for (const key of ['cursor', 'history', 'focus', 'streamProperty', 'streamDirection'])
    expect(url.searchParams.has(key)).toBe(false);
  expect(url.hash).toBe('#voice');
});

test('a selected native stream filters only rendering and leaves the immutable planning document intact', () => {
  const before = structuredClone(document);
  const selected = selectedStreamDocument(document, { entries, selected: 'voice' });
  const children = selected.content[0]!.props.children as PageDocument['content'];
  expect(children.map((node) => node.props.id)).toEqual(['heading', 'voice']);
  expect(document).toEqual(before);
  expect(selectedStreamDocument(document, undefined)).toBe(document);
  expect(selectedStreamDocument(document, { entries })).toBe(document);
});

test('the native role directory is localized, keyboard reachable and usable without JavaScript', async () => {
  const html = await renderSubject(
    createElement(SubjectStreamDirectory, { streams: { entries, selected: 'voice' }, document, locale: 'ja' }),
    '/ja/subjects/work/title/credits?node=voice&cursor=opaque&realm=r',
  );
  expect(html).toContain('監督');
  expect(html).toContain('声優');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('node=directors');
  expect(html).not.toContain('cursor=opaque');
  expect(html).toContain('realm=r');
  expect(html).toContain('min-h-11');
  expect(html).toContain('focus-visible:outline');
});
