import { expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import { applyReuse } from '../src/features/catalogue/reference-reuse';
import {
  captureScreenReuse,
  screenAdmitCreatedReader,
  screenDraftStructuredParts,
  screenFactDrafts,
  screenFactsFromDrafts,
  screenHolder,
  type ScreenDraftRow,
} from '../src/features/catalogue/screen-create-review';
import { screenInitialFacts } from '../src/features/catalogue/screen-profile';
import recorded from '../src/kernel/recorded/definitions-release.json';

const release = recorded.release as Release;

function director(index: number, parts: number): ScreenDraftRow {
  return {
    key: `row-${index}`,
    statement: {
      property: { id: 'schema:director' },
      value: { type: 'value', content: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}` },
      qualifiers: [],
      references: [
        {
          parts: Array.from({ length: parts }, (_, part) => ({
            property: { id: 'schema:url' },
            value: { type: 'value', content: `https://example.org/screen/${index}/${part}` },
          })),
        },
      ],
      rank: 'normal',
    },
  };
}

test('Screen creation admits native identity, keeps initial rank, and reuses references at 2/4/8 holders', () => {
  const ready = {
    state: 'ready' as const,
    href: '/en/subjects/00000000-0000-4000-8000-00000000c001/film',
    identity: { id: '00000000-0000-4000-8000-00000000c001', type: 'schema:Movie', label: 'Film' },
  };
  expect(screenAdmitCreatedReader(ready, ready.identity.id)).toEqual(ready);
  expect(screenAdmitCreatedReader(ready, '00000000-0000-4000-8000-00000000c002')).toEqual({ state: 'stale' });
  expect(
    screenAdmitCreatedReader({ ...ready, identity: { ...ready.identity, type: 'schema:Person' } }, ready.identity.id),
  ).toEqual({ state: 'stale' });
  expect(screenAdmitCreatedReader({ state: 'unavailable' }, ready.identity.id)).toEqual({ state: 'unavailable' });
  expect(screenAdmitCreatedReader({ state: 'concealed' }, ready.identity.id)).toEqual({ state: 'concealed' });
  expect(screenAdmitCreatedReader({ state: 'denied' }, ready.identity.id)).toEqual({ state: 'denied' });

  const url = {
    property: { id: 'schema:url' },
    value: { type: 'value' as const, content: 'https://example.org/film' },
    qualifiers: [],
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value' as const, content: 'https://example.org/src' } },
        ],
      },
    ],
    rank: 'normal' as const,
  };
  const prepared = screenInitialFacts(
    release,
    { type: 'schema:Movie', labels: { en: 'Film' }, descriptions: { en: 'A film.' }, aliases: { en: ['Picture'] } },
    [url],
  );
  expect(prepared.errors).toEqual([]);
  expect(prepared.item.statements['schema:url']![0]!.rank).toBe('normal');
  expect(prepared.item.aliases).toEqual({ en: ['Picture'] });

  // 2/4/8 holders × 16 reference parts: 34/68/136 structured parts under the native 16-part group limit.
  const native = { commands: 0, reads: 0 };
  for (const holders of [2, 4, 8]) {
    const rows = Array.from({ length: holders }, (_, index) => director(index, 16));
    expect(screenDraftStructuredParts(rows)).toBe(holders * 17);
    const reuse = captureScreenReuse(rows, 'schema:Movie', rows[0]!, 0);
    expect(reuse?.capture.source).toContain('https://example.org/screen/0/15');
    const selected = rows.slice(1).map(screenHolder);
    const result = applyReuse(screenFactDrafts(rows), reuse!.source, selected, release);
    expect(result.applied).toHaveLength(holders - 1);
    expect(result.refused).toEqual([]);
    const copied = screenFactsFromDrafts(result.drafts, rows);
    expect(copied[1]!.statement.references).toHaveLength(2);
    expect(copied[1]!.statement.references[1]).toEqual(rows[0]!.statement.references[0]);
    expect(copied[1]!.statement.value).toEqual(rows[1]!.statement.value);
    expect(copied[0]!.statement.references).toHaveLength(1);
    expect(native).toEqual({ commands: 0, reads: 0 });
  }
});
