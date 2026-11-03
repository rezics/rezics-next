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
  type LiteraryDraftRow,
} from '../src/features/catalogue/literary-create-review';
import { literaryInitialItem } from '../src/features/catalogue/literary-profile';
import recorded from '../src/kernel/recorded/definitions-release.json';

const release = recorded.release as Release;

function languageRow(index: number, parts: number): LiteraryDraftRow {
  return {
    id: `row-${index}`,
    statement: {
      property: { id: 'schema:inLanguage' },
      value: { type: 'value', content: index % 2 ? 'ja' : 'en' },
      qualifiers: [],
      references: [
        {
          parts: Array.from({ length: parts }, (_, part) => ({
            property: { id: 'schema:url' },
            value: { type: 'value', content: `https://example.org/literary/${index}/${part}` },
          })),
        },
      ],
      rank: 'normal',
    },
  };
}

test('Literary creation admits native identity, keeps initial rank, and reuses references at 2/4/8 holders', () => {
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

  // 2/4/8 holders × 16 reference parts: 34/68/136 structured parts under the 12-row and 16-part limits.
  const native = { commands: 0, reads: 0 };
  for (const holders of [2, 4, 8]) {
    const rows = Array.from({ length: holders }, (_, index) => languageRow(index, 16));
    expect(literaryDraftStructuredParts(rows)).toBe(holders * 17);
    const reuse = captureLiteraryReuse(rows, 'schema:Book', rows[0]!, 0);
    expect(reuse?.capture.source).toContain('https://example.org/literary/0/15');
    const selected = rows.slice(1).map(literaryHolder);
    const result = applyReuse(literaryFactDrafts(rows), reuse!.source, selected, release);
    expect(result.applied).toHaveLength(holders - 1);
    expect(result.refused).toEqual([]);
    const copied = literaryFactsFromDrafts(result.drafts, rows);
    expect(copied[1]!.statement.references).toHaveLength(2);
    expect(copied[1]!.statement.references[1]).toEqual(rows[0]!.statement.references[0]);
    expect(copied[1]!.statement.value).toEqual(rows[1]!.statement.value);
    expect(copied[0]!.statement.references).toHaveLength(1);
    expect(native).toEqual({ commands: 0, reads: 0 });
  }
});
