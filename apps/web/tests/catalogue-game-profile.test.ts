import { expect, test } from 'bun:test';
import { gameDraft, gameFields, gameType } from '../src/features/catalogue/game-profile';
import { statementInput } from '../src/features/catalogue/statement-editor';
import {
  gameExample,
  gameId,
  gamePlatformId,
  gameProfileFixture,
  gameStatement,
} from '../src/kernel/fake/catalogue-game-profile';

test('Game and visual-novel work editor uses actual released metadata native writes and current reader without fabricated grain or authority', async () => {
  for (const type of ['schema:VideoGame', 'wd:Q689445', 'wd:Q209163', 'wd:Q20631656']) {
    const fixture = gameProfileFixture();
    const item = gameExample(type);
    const draft = gameDraft(fixture.release, item, Object.values(item.statements).flat());
    expect(draft.errors).toEqual([]);
    expect(gameType(fixture.release, type)).toBe(true);
    const result = await fixture.transport.create({ item: draft.item, key: crypto.randomUUID() });
    expect(result).toEqual({
      ok: true,
      id: gameId,
      reader: { state: 'ready', href: `/en/subjects/${gameId}/the-lantern-game` },
    });
    expect(fixture.calls.find((call) => call.method === 'POST')).toMatchObject({
      path: '/v1/subjects',
      body: item,
      authorization: 'Bearer fixture',
    });
    expect(fixture.publicRead.subject.type).toBe(type);
    expect(fixture.publicRead.subject.sourceRecords).toEqual([]);
    expect(fixture.calls.filter((call) => call.path === '/v1/subjects' && call.method === 'POST')).toHaveLength(1);
    if (type === 'wd:Q689445') {
      expect(gameFields(fixture.release, type)).not.toContain('schema:gamePlatform');
      expect(
        gameDraft(fixture.release, item, [gameStatement('schema:gamePlatform', gamePlatformId)]).errors.length,
      ).toBeGreaterThan(0);
    } else {
      expect(fixture.publicRead.subject.statements['schema:gamePlatform']![0]!.qualifiers).toMatchObject([
        { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'ja' } },
      ]);
    }
    expect(gameFields(fixture.release, type)).not.toContain('schema:name');
    const baseline = structuredClone(fixture.publicRead.subject);
    const correction = statementInput(baseline.statements['schema:inLanguage']![0]!);
    correction.value = { type: 'value', content: 'fr' };
    const proposed = await fixture.transport.facts.propose({
      id: gameId,
      key: crypto.randomUUID(),
      statement: correction,
    });
    expect(proposed.ok && proposed.kind).toBe('proposed-awaiting-review');
    expect(fixture.publicRead.subject).toEqual(baseline);
    expect([...fixture.candidates.values()][0]?.decision).toBeNull();
    expect(fixture.calls.find((call) => call.path.endsWith('/candidates') && call.method === 'POST')?.body).toEqual({
      statement: correction,
    });
    expect(fixture.calls.some((call) => call.path.endsWith(gameId) && call.authorization === null)).toBe(true);
  }
});

test('Uncertain creation retains the exact command; platform correction preserves statement-level language and evidence', async () => {
  const fixture = gameProfileFixture('uncertain');
  const command = { item: gameExample(), key: crypto.randomUUID() };
  expect(await fixture.transport.create(command)).toEqual({ ok: false, reason: 'unavailable' });
  expect((await fixture.transport.create(command)).ok).toBe(true);
  expect(fixture.receipts.size).toBe(1);
  const writes = fixture.calls.filter((call) => call.method === 'POST');
  expect(writes[0]?.key).toBe(writes[1]?.key);
  expect(writes[0]?.body).toEqual(writes[1]?.body);
  const selected = fixture.publicRead.subject.statements['schema:gamePlatform']![0]!;
  const correction = statementInput(selected);
  correction.value = { type: 'value', content: '00000000-0000-4000-8000-00000000f105' };
  const result = await fixture.transport.classifications.propose({
    id: gameId,
    statement: correction,
    key: crypto.randomUUID(),
  });
  expect(result.ok).toBe(true);
  const candidate = [...fixture.candidates.values()][0]!;
  expect(candidate.statement.qualifiers).toEqual(selected.qualifiers);
  expect(candidate.statement.references).toEqual(selected.references);
  expect(fixture.publicRead.subject.statements['schema:gamePlatform']![0]).toEqual(selected);
});
