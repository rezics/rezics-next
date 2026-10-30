import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import platform from '@rezics/composition/profiles/platform.json';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import type { PageMessages } from '../src/features/pages/data.tsx';

const id = '01a1740d-7480-71e4-841f-66c04022d7d0';
const context = '00000000-0000-8000-8000-000000000000';
const work = (
  platform.bases.find(({ base }) => base === 'schema:CreativeWork') as unknown as {
    views: { overview: CompositionDocument };
  }
).views.overview;
const value = (content: unknown) => ({ type: 'value', content });
const statement = (property: string, dataType: string, content: unknown, references: unknown[] = []) => ({
  id: '01a1740d-7480-71e4-841f-66c04022d7d1',
  rank: 'normal',
  property: { id: property, data_type: dataType },
  value: value(content),
  qualifiers: [],
  references,
  rezics: { release: 'sha256:release', revision: 1 },
});
const reference = (url: string) => ({
  parts: [{ property: { id: 'schema:url', data_type: 'url' }, value: value(url) }],
});

function page(
  sourceRecords: unknown[] = [],
  withReference = true,
  withFacts = true,
  summary: unknown = null,
): SubjectPageData {
  const statements = withFacts
    ? {
        'schema:genre': [
          statement(
            'schema:genre',
            'string',
            'fantasy',
            withReference
              ? [reference('https://archive.example.test/record-1'), reference('https://other.example.test/source')]
              : [],
          ),
        ],
        'schema:isbn': [statement('schema:isbn', 'external-id', '9780000000000')],
      }
    : {};
  const subject = {
    id,
    type: 'schema:Book',
    revision: 1,
    release: 'sha256:release',
    context,
    resolution: {},
    labels: { en: 'Source Book' },
    descriptions: {},
    aliases: {},
    statements,
    sourceRecords,
  };
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(planReads(platformRegistry, work, { subject: id }).reads))
    reads[key] =
      read.kind === 'subject'
        ? {
            status: 200,
            body: {
              subject,
              related: { 'schema:genre': { labels: { en: 'Genre' } }, 'schema:isbn': { labels: { en: 'ISBN' } } },
              summary,
            },
          }
        : read.kind === 'links'
          ? { status: 200, body: { links: [], count: { value: 0, exact: true }, next: null } }
          : read.kind === 'collections'
            ? { status: 200, body: { collections: [], count: { value: 0, exact: true }, next: null } }
            : { status: 200, body: { subjects: [], total: { value: 0, relation: 'exact' }, next: null, as_of: '' } };
  return {
    subject: id,
    profile: 'sha256:release',
    template: { scope: 'base', key: 'schema:CreativeWork' },
    document: work as never,
    reads,
  };
}

const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
  source: 'Source',
};
const render = (data: SubjectPageData) =>
  renderToString(createElement(SubjectPage, { page: data, locale: 'en', messages, renderJsonLd: false } as never));

test('Sources lists every read source record in order with linked or plain SPDX licence and attribution text', () => {
  const records = [
    {
      name: 'Original archive bibliography',
      url: 'https://archive.example.test/record-1',
      licence: { id: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
      attribution: 'Archive Curators',
    },
    {
      name: 'Long source name: ' + 'Archive and catalogue '.repeat(8),
      url: 'https://catalogue.example.test/record-2',
      licence: { id: 'CC0-1.0' },
    },
    { name: 'Research notes', url: 'https://notes.example.test/record-3', attribution: 'M. Researcher' },
    { name: 'Unannotated source', url: 'https://source.example.test/record-4' },
  ];
  const html = render(page(records));
  const section = html.slice(html.indexOf('data-slot="subject-sources"'));
  const positions = records.map(({ name }) => section.indexOf(name));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(section).toContain('href="https://archive.example.test/record-1"');
  expect(section).toContain('href="https://creativecommons.org/licenses/by/4.0/"');
  expect(section).toContain('CC-BY-4.0');
  expect(section).toContain('CC0-1.0');
  expect(section).toContain('Archive Curators');
  expect(section).toContain('M. Researcher');
  expect(section).not.toContain('href="CC0-1.0"');
  expect(section).not.toContain('<script');
});

test('a reference that equals a source record URL appears once as that named record; other references and identifiers remain', () => {
  const html = render(page([{ name: 'Original archive bibliography', url: 'https://archive.example.test/record-1' }]));
  const section = html.slice(html.indexOf('data-slot="subject-sources"'));
  expect(section.match(/https:\/\/archive\.example\.test\/record-1/g)).toHaveLength(1);
  expect(section).toContain('https://other.example.test/source');
  expect(section).toContain('9780000000000');
});

test('an empty sourceRecords array keeps the ordinary Sources section, and a section with no listed facts renders empty', () => {
  const ordinary = render(page([]));
  expect(ordinary).toContain('data-slot="subject-sources"');
  expect(ordinary).toContain('https://archive.example.test/record-1');
  const noSources = render(page([], false, false));
  expect(noSources).not.toContain('data-slot="subject-sources"');
});

test('the cover credit stays in the Sources section at the end of the page', () => {
  const html = render(
    page([], false, false, {
      id,
      type: 'schema:Book',
      types: ['schema:Book'],
      cover: {
        media: 'cover-media',
        width: 1200,
        height: 1800,
        placeholder: { thumbhash: '', color: '#456' },
        variants: [{ format: 'webp', width: 1200 }],
        focalPoint: null,
        credit: {
          rightsHolder: 'Original Photographer',
          via: { name: 'The Archive', url: 'https://archive.example.test/' },
          license: 'CC BY 4.0',
        },
      },
    }),
  );
  const section =
    html.match(/<section data-slot="subject-sources"[\s\S]*?<\/section>/)?.[0]?.replaceAll('<!-- -->', '') ?? '';
  expect(section).toContain('© Original Photographer');
  expect(section).toContain('href="https://archive.example.test/"');
  expect(section).toContain('The Archive');
  expect(section).toContain('CC BY 4.0');
});

test('source records arrive in the existing subject read without adding a kernel read', async () => {
  const requests: string[] = [];
  const client = {
    pages: {
      $read: {
        async post() {
          requests.push('POST /v1/pages:read');
          return {
            status: 200,
            data: {
              subject: id,
              profile: 'sha256:release',
              template: { scope: 'base', key: 'schema:CreativeWork' },
              document: work,
              reads: {},
            },
          };
        },
      },
    },
  };
  const { loadSubjectPage } = await import('../src/features/pages/subject.tsx');
  await loadSubjectPage(client as never, id, undefined, 'en');
  expect(requests).toEqual(['POST /v1/pages:read']);
});
