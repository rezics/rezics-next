import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { Related, Subject } from '../src/subject/types';
import { WorkTagReading } from '../src/features/catalogue/work-tag-reading/entry';
import { loadSubjectPage } from '../src/features/pages/subject.tsx';
import { createKernelClient } from '@rezics/client';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';

const holder = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const tag = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e04';
const hiddenTag = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e99';
const spoilerTag = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e05';
const kernel = createKernelClient('https://kernel.invalid', { fetch: createFakeKernelFetch(fixtures as never) });

const snak = (property: string, data_type: string, content: unknown) => ({
  property: { id: property, data_type },
  value: { type: 'value', content },
});

function taggedStatement(id: string, target: string, amount?: string, spoiler = 0) {
  return {
    id,
    rank: 'normal',
    property: { id: 'schema:keywords', data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    qualifiers: [
      ...(amount === undefined
        ? []
        : [
            snak('rezics:sourceTagWeight', 'quantity', { amount, unit: '1' }),
            snak('rezics:sourceTagWeightMetric', 'string', 'vndbTagsRating'),
          ]),
      ...(spoiler === 0 ? [] : [snak('rezics:spoilerLevel', 'quantity', { amount: `+${spoiler}`, unit: '1' })]),
    ],
    references:
      amount === undefined
        ? []
        : [
            {
              parts: [
                snak('schema:url', 'url', 'https://vndb.org/v17'),
                snak('rezics:sourceTagId', 'string', 'g3'),
                snak('rezics:sourceSnapshot', 'string', `unversioned:sha256:${'a'.repeat(64)}`),
              ],
            },
            { parts: [snak('schema:url', 'url', 'https://api.vndb.org/kana#post-vn')] },
          ],
  };
}

function readBody(page: Awaited<ReturnType<typeof loadSubjectPage>>): { subject: Subject; related: Related } {
  if (page.kind !== 'page') throw new Error(`Expected a page, received ${page.kind}`);
  const read = Object.values(page.page.reads).find((entry) => {
    const body = entry.body as { subject?: { id?: string } };
    return entry.status === 200 && body.subject?.id === holder;
  });
  if (!read) throw new Error('The public page did not contain the selected Subject read');
  return read.body as { subject: Subject; related: Related };
}

function render(
  subject: Subject,
  related: Related,
  definitions: NonNullable<Parameters<typeof WorkTagReading>[0]['definitions']>,
  spoilerLevel: 0 | 1 | 2,
) {
  return renderToString(
    createElement(WorkTagReading, { subject, related, definitions, locale: 'en', spoilerThreshold: spoilerLevel }),
  );
}

function tagDefinitions(subject: Subject): NonNullable<Parameters<typeof WorkTagReading>[0]['definitions']> {
  return {
    types: {
      [subject.type]: { bases: ['schema:CreativeWork'], facets: ['schema:keywords'] },
      'schema:CreativeWork': { bases: [], facets: [] },
      'skos:Concept': { bases: [], facets: [] },
    },
    properties: {
      'schema:keywords': {
        labels: { en: 'Keywords' },
        datatype: 'wikibase-item',
        targets: ['skos:Concept'],
      },
    },
  } as NonNullable<Parameters<typeof WorkTagReading>[0]['definitions']>;
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ');

test('public tag chips use the disclosed Concept label and destination, keep source evidence per association, and gate spoilers', async () => {
  const loaded = await loadSubjectPage(kernel, holder);
  if (loaded.kind !== 'page') throw new Error(`Expected a page, received ${loaded.kind}`);
  const { subject, related } = readBody(loaded);
  const definitions = tagDefinitions(subject);
  const statements = subject.statements as Record<string, unknown[]>;
  statements['schema:keywords'] = [
    taggedStatement('0192f3a0-6c1e-8b2a-9d4e-1a2b3c4d5f40', tag, '+2.59999990463257'),
    taggedStatement('0192f3a0-6c1e-8b2a-9d4e-1a2b3c4d5f41', tag),
    taggedStatement('0192f3a0-6c1e-8b2a-9d4e-1a2b3c4d5f42', hiddenTag, '+2.3'),
    taggedStatement('0192f3a0-6c1e-8b2a-9d4e-1a2b3c4d5f43', spoilerTag, '+2.1', 2),
  ];
  related[tag] = { type: 'skos:Concept', labels: { en: 'Shared tag' } } as Related[string];
  related[spoilerTag] = { type: 'skos:Concept', labels: { en: 'Late story tag' } } as Related[string];

  const safe = render(subject, related, definitions, 0);
  const safeText = text(safe);
  expect(safeText).toContain('Shared tag');
  expect(safeText).not.toContain(tag);
  expect(safeText).not.toContain('Late story tag');
  expect(safeText).not.toContain(hiddenTag);
  expect(safeText).not.toContain('2.3 / 3');
  expect(safeText).toContain('2.59999990463257 / 3');
  expect(safe).toContain('https://api.vndb.org/kana#post-vn');
  const conceptHref = new RegExp(`href="([^"]*/subjects/${tag}/shared-tag[^\"]*)"`, 'u').exec(safe)?.[1];
  expect(conceptHref).toBeDefined();
  expect(new URL(conceptHref!, 'https://site.test').searchParams.has('returnTo')).toBe(true);
  expect(safe.match(/data-slot="source-tag-weight" data-state="available"/gu)).toHaveLength(1);
  expect(safe.match(/data-slot="source-tag-weight" data-state="absent"/gu)).toHaveLength(1);

  const revealed = render(subject, related, definitions, 2);
  const revealedText = text(revealed);
  expect(revealedText).toContain('Late story tag');
  expect(revealedText).toContain('2.1 / 3');
  expect(revealedText).not.toContain(hiddenTag);
});

test('unsupported and absent metrics never receive a numeric fallback', async () => {
  const loaded = await loadSubjectPage(kernel, holder);
  if (loaded.kind !== 'page') throw new Error(`Expected a page, received ${loaded.kind}`);
  const { subject, related } = readBody(loaded);
  const definitions = tagDefinitions(subject);
  (subject.statements as Record<string, unknown[]>)['schema:keywords'] = [
    taggedStatement('0192f3a0-6c1e-8b2a-9d4e-1a2b3c4d5f44', tag, '+2.4'),
  ];
  const statement = (subject.statements as Record<string, any[]>)['schema:keywords']![0]!;
  statement.qualifiers[1].value.content = 'rawIndividualVote';
  const unsupported = text(render(subject, related, definitions, 0));
  expect(unsupported).toContain('Unsupported source metric');
  expect(unsupported).not.toContain('2.4 / 3');

  statement.qualifiers = [];
  statement.references = [];
  const absent = text(render(subject, related, definitions, 0));
  expect(absent).not.toContain('Unsupported source metric');
  expect(absent).not.toContain('2.4 / 3');
});
