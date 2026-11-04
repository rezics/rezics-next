import { expect, test } from 'bun:test';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision } from '../../../packages/conversion/src/bangumi.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

type RegisteredConversion = ReturnType<ReturnType<typeof createSourceRegistration>['convert']>;

const gameId = '98001';
const gameUuid = 'd0000000-0000-4000-8000-000000000001';
const recordUrl = `https://bgm.tv/subject/${gameId}`;

function game(infobox: string) {
  return { id: Number(gameId), type: 4, name: 'Source-shaped Game', infobox };
}

function convert(infobox: string) {
  const registration = createSourceRegistration('bangumi');
  return {
    registration,
    result: registration.convert(
      { external_id: gameId, record_revision: null, record: game(infobox) },
      { source: registration.source, subjectId: gameUuid },
    ),
  };
}

function proposals(result: RegisteredConversion) {
  return result.proposals.filter((command): command is Extract<BatchCommand, { op: 'propose' }> => command.op === 'propose');
}

function value(command: Extract<BatchCommand, { op: 'propose' }>) {
  return command.statement.value.type === 'value' ? command.statement.value.content : undefined;
}

test('Bangumi Game destinations retain exact native properties and withhold unsafe field occurrences', () => {
  const { registration, result } = convert(
    [
      '{{Infobox Game',
      '|website=https://Official.Game.example/portal?region=global#home',
      '|website=[[https://edition.game.example|Switch edition]]',
      '|website=javascript:alert(1)',
      '|website=https://user:secret@private.example/path',
      '|链接=https://guide.example/story?chapter=2#walkthrough',
      '|链接=https://mixed.example/guide with extra prose',
      '|发行日期=2004-04-28',
      '|游玩人数=1人',
      '}}',
    ].join('\n'),
  );
  const destinations = proposals(result).filter((command) => ['schema:url', 'wdt:P973'].includes(command.statement.property.id));

  expect(registration.converter_revision).toBe(converter_revision);
  expect(registration.converter_revision).toBe('bangumi@14');
  expect(destinations.map((command) => [command.statement.property.id, value(command)])).toEqual([
    ['schema:url', 'https://Official.Game.example/portal?region=global#home'],
    ['wdt:P973', 'https://guide.example/story?chapter=2#walkthrough'],
  ]);
  expect(destinations.map((command) => command.statement.references?.[0]?.parts[0])).toEqual([
    { property: { id: 'schema:url' }, value: { type: 'value', content: recordUrl } },
    { property: { id: 'schema:url' }, value: { type: 'value', content: recordUrl } },
  ]);
  expect(destinations.map((command) => command.statement.references?.[0]?.parts[1]?.value)).toEqual([
    { type: 'value', content: `${recordUrl}#/infobox/fields/0` },
    { type: 'value', content: `${recordUrl}#/infobox/fields/4` },
  ]);
  expect('gameWebDestinationEvidence' in result ? result.gameWebDestinationEvidence : undefined).toEqual([
    { field: 'website', pointer: '/infobox/fields/0', outcome: 'admitted', property: 'schema:url' },
    { field: 'website', pointer: '/infobox/fields/1', outcome: 'withheld', code: 'qualified_game_destination' },
    { field: 'website', pointer: '/infobox/fields/2', outcome: 'withheld', code: 'invalid_game_destination_url' },
    { field: 'website', pointer: '/infobox/fields/3', outcome: 'withheld', code: 'invalid_game_destination_url' },
    { field: '链接', pointer: '/infobox/fields/4', outcome: 'admitted', property: 'wdt:P973' },
    { field: '链接', pointer: '/infobox/fields/5', outcome: 'withheld', code: 'malformed_game_destination' },
  ]);
  expect(result.diagnostics).toContainEqual({
    pointer: '/infobox/fields/5',
    code: 'malformed_game_destination',
  });
  expect(proposals(result).some((command) => command.statement.property.id === 'wdt:P5732')).toBe(true);
  expect(proposals(result).some((command) => command.statement.property.id === 'schema:datePublished')).toBe(true);
  expect(proposals(result).some((command) => command.statement.property.id === 'schema:numberOfPlayers')).toBe(true);
});

test('Game destination overflow is an explicit bounded omission', () => {
  const fields = Array.from(
    { length: 17 },
    (_, index) => `|${index % 2 ? '链接' : 'website'}=https://destination.example/${index}`,
  );
  const { result } = convert(['{{Infobox Game', ...fields, '}}'].join('\n'));
  const destinations = proposals(result).filter((command) =>
    ['schema:url', 'wdt:P973'].includes(command.statement.property.id),
  );

  expect(destinations).toHaveLength(16);
  expect(result.diagnostics).toContainEqual({
    pointer: '/infobox/fields/16',
    code: 'game_destination_limit',
  });
  const withheld = convert(['{{Infobox Game', ...Array(16).fill('|website=javascript:alert(1)'), fields[16], '}}'].join('\n')).result;
  expect(proposals(withheld).some((command) => command.statement.property.id === 'schema:url')).toBe(false);
  expect(withheld.diagnostics).toContainEqual({ pointer: '/infobox/fields/16', code: 'game_destination_limit' });
});
