import { expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import { applyReuse } from '../src/features/catalogue/reference-reuse';
import {
  captureLiteraryReuse,
  literaryAdmitCreatedReader,
  literaryDraftStructuredParts,
  literaryFactDrafts,
  literaryFactsFromDrafts,
  literaryHolder,
  literaryStructuredParts,
  type LiteraryDraftRow,
} from '../src/features/catalogue/literary-create-review';
import { literaryInitialItem } from '../src/features/catalogue/literary-profile';
import recorded from '../src/kernel/recorded/definitions-release.json';

const release = recorded.release as Release;

function languageRow(index: number, groupLengths: readonly number[]): LiteraryDraftRow {
  return {
    id: `row-${index}`,
    statement: {
      property: { id: 'schema:inLanguage' },
      value: { type: 'value', content: index % 2 ? 'ja' : 'en' },
      qualifiers: [],
      references: groupLengths.map((length, group) => ({
        parts: Array.from({ length }, (_, part) => ({
          property: { id: 'schema:url' },
          value: { type: 'value', content: `https://example.org/literary/${index}/${group}/${part}` },
        })),
      })),
      rank: 'normal',
    },
  };
}

test('Literary creation admits exact identity and reuses evidence across 32/128/512 structured parts', () => {
  const ready = {
    state: 'ready' as const,
    href: '/en/subjects/00000000-0000-4000-8000-00000000b001/book',
    identity: { id: '00000000-0000-4000-8000-00000000b001', type: 'schema:Book', label: 'Book' },
  };
  expect(literaryAdmitCreatedReader(ready, ready.identity.id, 'schema:Book')).toEqual(ready);
  expect(literaryAdmitCreatedReader(ready, '00000000-0000-4000-8000-00000000b002', 'schema:Book')).toEqual({
    state: 'stale',
  });
  const otherLiteraryType = { ...ready, identity: { ...ready.identity, type: 'schema:BookSeries' } };
  expect(literaryAdmitCreatedReader(otherLiteraryType, ready.identity.id, 'schema:Book')).toEqual({ state: 'stale' });
  expect(literaryAdmitCreatedReader(otherLiteraryType, ready.identity.id, 'schema:BookSeries')).toEqual(otherLiteraryType);
  expect(
    literaryAdmitCreatedReader(
      { ...ready, identity: { ...ready.identity, type: 'schema:Person' } },
      ready.identity.id,
      'schema:Book',
    ),
  ).toEqual({ state: 'stale' });
  expect(literaryAdmitCreatedReader({ state: 'unavailable' }, ready.identity.id, 'schema:Book')).toEqual({
    state: 'unavailable',
  });
  expect(literaryAdmitCreatedReader({ state: 'concealed' }, ready.identity.id, 'schema:Book')).toEqual({
    state: 'concealed',
  });
  expect(literaryAdmitCreatedReader({ state: 'denied' }, ready.identity.id, 'schema:Book')).toEqual({ state: 'denied' });

  const prepared = literaryInitialItem(
    release,
    { type: 'schema:Book', labels: { en: 'Book', ja: '書籍' }, descriptions: { en: 'A work.' }, aliases: { en: ['Volume'] } },
    [
      {
        property: { id: 'schema:url' },
        value: { type: 'value', content: 'https://example.org/book' },
        qualifiers: [],
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/src' } },
            ],
          },
        ],
        rank: 'normal',
      },
    ],
    'en',
  );
  expect(prepared.errors).toEqual([]);
  expect(prepared.item.statements['schema:url']![0]!.rank).toBe('normal');
  expect(prepared.item.aliases).toEqual({ en: ['Volume'] });
  expect(prepared.item.labels).toEqual({ en: 'Book', ja: '書籍' });

  const initial = {
    type: 'schema:Book',
    labels: { en: 'Book' },
    descriptions: { en: 'A work.' },
    aliases: { en: ['Volume'] },
  };
  const scales = [
    { groupLengths: [7], input: 32, output: 53 },
    { groupLengths: [7, 16, 8], input: 128, output: 149 },
    { groupLengths: [7, 16, 16, 16, 16, 16, 16, 16, 8], input: 512, output: 533 },
  ] as const;
  // Four admitted holders, zero qualifiers; copying the source's seven-part group to three targets adds 21 parts.
  for (const { groupLengths, input, output } of scales) {
    const rows = Array.from({ length: 4 }, (_, index) => languageRow(index, groupLengths));
    const projected = literaryInitialItem(release, initial, rows.map((row) => row.statement), 'en');
    expect(projected.errors).toEqual([]);
    expect(literaryDraftStructuredParts(rows)).toBe(input);
    expect(literaryStructuredParts(projected.item)).toBe(input);
    const reuse = captureLiteraryReuse(rows, 'schema:Book', rows[0]!, 0);
    expect(reuse?.capture.source).toContain('https://example.org/literary/0/0/6');
    const selected = rows.slice(1).map(literaryHolder);
    const result = applyReuse(literaryFactDrafts(rows), reuse!.source, selected, release);
    expect(result.applied).toHaveLength(3);
    expect(result.refused).toEqual([]);
    const copied = literaryFactsFromDrafts(result.drafts, rows);
    expect(copied[1]!.statement.references).toHaveLength(groupLengths.length + 1);
    expect(copied[1]!.statement.references.slice(0, groupLengths.length)).toEqual(rows[1]!.statement.references);
    expect(copied[1]!.statement.references[groupLengths.length]).toEqual(rows[0]!.statement.references[0]);
    expect(copied[1]!.statement.references[groupLengths.length]).not.toBe(rows[0]!.statement.references[0]);
    expect(copied[1]!.statement.references[groupLengths.length]).not.toBe(
      copied[2]!.statement.references[groupLengths.length],
    );
    expect(copied[1]!.statement.value).toEqual(rows[1]!.statement.value);
    const prepared = literaryInitialItem(release, initial, copied.map((row) => row.statement), 'en');
    expect(prepared.errors).toEqual([]);
    expect(literaryStructuredParts(prepared.item)).toBe(output);
  }
});
