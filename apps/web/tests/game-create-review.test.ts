import { expect, mock, test } from 'bun:test';
import type { GameCreateRow } from '../src/features/catalogue/game-create-review-model';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const { gameCreationAddress } = await import('../src/features/catalogue/game-creation-address');
const {
  applyGameCreateReuse,
  captureGameCreateReuse,
  gameAdmitCreatedReader,
  gameCreateDrafts,
  gameCreateGrain,
  gameCreateHolder,
  gameCreateNativeContent,
  gameCreateUnsupported,
  visitGameCreateParts,
} = await import('../src/features/catalogue/game-create-review-model');
const { reuseIsStale } = await import('../src/features/catalogue/reference-reuse');
const { gameDefinitions, gameDraft, gameType } = await import('../src/features/catalogue/game-profile');
const { gamePlatformId, gameProfileFixture, gameStatement } = await import(
  '../src/kernel/fake/catalogue-game-profile'
);

function cited(
  property: string,
  content: unknown,
  source: string,
  extra: GameCreateRow['statement']['references'][number]['parts'] = [],
): GameCreateRow {
  const statement = gameStatement(property, content);
  statement.references = [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: source } }, ...extra] },
  ];
  return { key: crypto.randomUUID(), statement };
}

test('Game creation review admits current types, native values and independent reference copies', () => {
  const fixture = gameProfileFixture();
  const offered = gameDefinitions(fixture.release, 'en');
  expect(offered.map((entry) => entry.id).sort()).toEqual(
    ['schema:VideoGame', 'wd:Q20631656', 'wd:Q209163', 'wd:Q689445'].sort(),
  );
  expect(offered.find((entry) => entry.id === 'wd:Q689445')?.bases).toContain('schema:VideoGame');
  expect(gameCreateGrain(fixture.release, 'schema:VideoGame')).toBe('work');
  expect(gameCreateGrain(fixture.release, 'wd:Q689445')).toBe('work');
  expect(gameCreateGrain(fixture.release, 'wd:Q209163')).toBe('addon');
  expect(gameCreateGrain(fixture.release, 'wd:Q20631656')).toBe('release');
  expect(gameType(fixture.release, 'schema:Person')).toBe(false);

  const date = {
    property: { id: 'schema:datePublished' },
    value: {
      type: 'value' as const,
      content: {
        time: '+2020-05-01T00:00:00Z',
        precision: 11,
        calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      },
    },
    rank: 'normal' as const,
    qualifiers: [],
    references: [],
  };
  const quantity = {
    property: { id: 'schema:numberOfPlayers' },
    value: { type: 'value' as const, content: { amount: '+2', unit: '1' } },
    rank: 'normal' as const,
    qualifiers: [],
    references: [],
  };
  expect(gameCreateNativeContent(date, 'time')).toContain('"precision":11');
  expect(gameCreateNativeContent(quantity, 'quantity')).toContain('"amount":"+2"');
  expect(gameCreateNativeContent(gameStatement('schema:gamePlatform', gamePlatformId), 'wikibase-item')).toBe(
    gamePlatformId,
  );

  const source = cited('schema:url', 'https://example.org/game', 'https://example.org/game-source', [
    { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
  ]);
  const target = cited('schema:inLanguage', 'ja', 'https://example.org/other');
  const reuse = captureGameCreateReuse([source, target], source.key, 0)!;
  reuse.selected = [gameCreateHolder(target.key)];
  const applied = applyGameCreateReuse([source, target], reuse, fixture.release);
  expect(applied.reuse.applied).toEqual([
    { holder: gameCreateHolder(target.key), property: 'schema:inLanguage', index: 1 },
  ]);
  expect(applied.rows[1]!.statement.references).toHaveLength(2);
  expect(applied.rows[1]!.statement.references[1]).toEqual(source.statement.references[0]);
  expect(applied.rows[1]!.statement.references[1]).not.toBe(source.statement.references[0]);
  expect(applied.rows[1]!.statement.value).toEqual({ type: 'value', content: 'ja' });
  expect(applied.rows[1]!.statement.rank).toBe('normal');
  applied.rows[1]!.statement.references[1]!.parts[0]!.value = {
    type: 'value',
    content: 'https://example.org/edited-copy',
  };
  expect(applied.rows[0]!.statement.references[0]!.parts[0]!.value).toEqual({
    type: 'value',
    content: 'https://example.org/game-source',
  });

  const locked = captureGameCreateReuse([source, target], source.key, 0)!;
  locked.selected = [gameCreateHolder(target.key)];
  expect(
    reuseIsStale(locked.source, gameCreateDrafts([source, target]), locked.selected, locked.capture),
  ).toBe(false);
  target.statement.references = [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/changed' } }] },
  ];
  expect(reuseIsStale(locked.source, gameCreateDrafts([source, target]), locked.selected, locked.capture)).toBe(true);
  source.statement.references = [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/source-changed' } }] },
  ];
  const stale = applyGameCreateReuse([source, target], locked, fixture.release);
  expect(stale.reuse.applied).toEqual([]);

  const retired = gameDraft(
    fixture.release,
    { type: 'schema:VideoGame', labels: { en: 'Kept' }, descriptions: {}, aliases: {} },
    [gameStatement('schema:name', 'not-a-creation-field')],
  );
  expect(gameCreateUnsupported(retired.item, fixture.release)).toContain('schema:name');
  expect(
    gameCreationAddress('/statements/schema:inLanguage/0/value/content', [target], fixture.release, 'en')?.id,
  ).toContain(gameCreateHolder(target.key));
  expect(gameCreationAddress('/statements/schema:inLanguage/0/value/content', [], fixture.release, 'en')).toBeUndefined();
  expect(
    gameAdmitCreatedReader(
      {
        state: 'ready',
        href: '/x',
        identity: { id: '00000000-0000-4000-8000-00000000f101', type: 'schema:Person', label: 'No' },
      },
      '00000000-0000-4000-8000-00000000f101',
      fixture.release,
    ).state,
  ).toBe('stale');
});

test('Game creation projection and reference reuse visit 32/64/128 structured parts with no native commands', () => {
  const fixture = gameProfileFixture();
  const writes = fixture.calls.length;
  for (const parts of [32, 64, 128]) {
    const holders = Math.min(32, parts / 4);
    const perGroup = parts / holders - 1;
    const rows: GameCreateRow[] = Array.from({ length: holders }, (_, index) => ({
      key: `growth-${parts}-${index}`,
      statement: {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: `en-${index}` },
        rank: 'normal',
        qualifiers: [],
        references: [
          {
            parts: Array.from({ length: perGroup }, (_, part) => ({
              property: { id: 'schema:url' },
              value: { type: 'value' as const, content: `https://example.org/growth/${parts}/${index}/${part}` },
            })),
          },
        ],
      },
    }));
    const visited: string[] = [];
    expect(visitGameCreateParts(rows, (part) => visited.push(JSON.stringify(part.value)))).toBe(parts);
    expect(visited).toHaveLength(parts);
    const reuse = captureGameCreateReuse(rows, rows[0]!.key, 0)!;
    reuse.selected = rows.slice(1, 3).map((row) => gameCreateHolder(row.key));
    const result = applyGameCreateReuse(rows, reuse, fixture.release);
    expect(result.reuse.applied).toHaveLength(2);
    expect(result.rows[1]!.statement.references).toHaveLength(2);
    expect(result.rows[1]!.statement.references[1]!.parts).toHaveLength(perGroup);
    expect(result.rows[1]!.statement.references[1]).not.toBe(rows[0]!.statement.references[0]);
  }
  expect(fixture.calls.length).toBe(writes);
});
