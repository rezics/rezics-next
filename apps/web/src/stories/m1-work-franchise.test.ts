import { expect, mock, test } from 'bun:test';
import type { ProfileRelationWindow } from '../features/pages/views';
import type { RelationDefinition } from '../subject/relations';

// The projection needs no Workers bindings; match the existing Bun component-control environment.
mock.module('cloudflare:workers', () => ({ env: {} }));
const { directedWorkRelations, showcaseWorkKind, workFranchiseGroups } =
  await import('../features/pages/showcase-work/model');
const { workFranchisePeerStream } = await import('../features/catalogue/work-franchise-reading/navigation');

// Authored native-response controls. These UUIDs do not identify seeded catalogue objects.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const vn = id(1),
  anime = id(2),
  book = id(3);
function assertion(property: string, target: string, n = 10) {
  return {
    id: id(n),
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    qualifiers: [],
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://bgm.tv/subject/10380' },
          },
        ],
      },
    ],
  };
}
function summary(target: string, type = 'schema:TVSeries') {
  return { id: target, type, label: { language: 'en', value: 'Authored work' } };
}
function window(
  property: string,
  rows: unknown[],
  direction: 'forward' | 'inverse' = 'forward',
): ProfileRelationWindow {
  return { node: property, property, direction, rows, status: 200, valid: true, complete: true, limit: 20 };
}

test('native forward and reverse visits retain the original holder, direction and source evidence', () => {
  expect(workFranchisePeerStream('out', 'wdt:P144')).toBe('in:wdt:P144');
  expect(workFranchisePeerStream('in', 'wdt:P144')).toBe('out:wdt:P144');
  const original = assertion('wdt:P144', vn);
  const outward = directedWorkRelations(anime, 'wdt:P144', 'out', {
    relations: [{ target: vn, statement: original, summary: summary(vn, 'wd:Q689445') }],
  })!;
  const returning = directedWorkRelations(vn, 'wdt:P144', 'in', {
    links: [{ subject: anime, statement: original.id, assertion: original, summary: summary(anime) }],
  })!;
  expect(outward.map(({ holder, direction, id, kind }) => ({ holder, direction, id, kind }))).toEqual([
    { holder: anime, direction: 'out', id: vn, kind: 'visual-novel' },
  ]);
  expect(returning.map(({ holder, direction, id }) => ({ holder, direction, id }))).toEqual([
    { holder: anime, direction: 'in', id: anime },
  ]);
  expect(returning[0]!.statement).toBe(original);
  expect(returning[0]!.statement.references).toBe(original.references);
  expect(showcaseWorkKind('schema:BookSeries', ['schema:Book'])).toBe('book-series');
  const series = directedWorkRelations(vn, 'rezics:crossMediaCounterpart', 'out', {
    relations: [
      {
        target: book,
        statement: assertion('rezics:crossMediaCounterpart', book),
        summary: summary(book, 'schema:BookSeries'),
      },
    ],
  });
  expect(series?.[0]?.kind).toBe('book-series');
});

test('concealed endpoints have no destination; malformed endpoint identities invalidate the whole native page', () => {
  const row = { target: anime, statement: assertion('wdt:P144', anime), summary: summary(anime) };
  expect(directedWorkRelations(vn, 'wdt:P144', 'out', { relations: [{ ...row, summary: null }] })).toEqual([]);
  expect(
    directedWorkRelations(vn, 'wdt:P144', 'out', {
      relations: [row, { ...row, summary: summary(book) }],
    }),
  ).toBeUndefined();
  expect(
    directedWorkRelations(vn, 'wdt:P144', 'in', {
      links: [{ subject: anime, statement: row.statement.id, assertion: row.statement, summary: summary(anime) }],
    }),
  ).toEqual([]); // The original points at anime, not the visited VN.
});

test('cyclic and high-degree returned windows stay bounded without expanding their neighbors', () => {
  const properties = ['wdt:P144', 'wdt:P155', 'rezics:sideStoryOf', 'rezics:crossMediaCounterpart'];
  const windows = properties.map((property) =>
    window(
      property,
      Array.from({ length: 20 }, (_, n) => ({
        target: id(100 + n),
        statement: assertion(property, id(100 + n), 200 + n),
        summary: summary(id(100 + n)),
      })),
    ),
  );
  const definitions = Object.fromEntries(
    properties.map((property): [string, RelationDefinition] => [
      property,
      {
        label: property,
        forwardLabel: property,
        group: 'derivation',
        symmetric: false,
      },
    ]),
  );
  const groups = workFranchiseGroups(vn, windows, definitions);
  expect(groups.map((group) => group.preview.length)).toEqual([3, 3, 3, 3]);
  expect(groups.every((group) => group.more)).toBe(true);
  expect(workFranchiseGroups(vn, [windows[0]!], definitions, true)[0]?.preview).toHaveLength(20);
  const cyclic = window(
    'wdt:P155',
    [{ subject: anime, statement: id(10), assertion: assertion('wdt:P155', vn), summary: summary(anime) }],
    'inverse',
  );
  expect(workFranchiseGroups(vn, [cyclic], definitions)[0]?.preview.map((row) => row.id)).toEqual([anime]);
});
