import { expect, test } from 'bun:test';
import type { ReviewedCandidatePage, ReviewedSubjectRead } from '../src/import-client.ts';
import {
  bangumiGameSourceGenreReference,
  bangumiGameSourceGenreScheme,
  bangumiGameSourceGenres,
} from '../../../packages/conversion/src/bangumi-game-source-genres.ts';
import { converter_revision } from '@rezics/conversion/bangumi';
import {
  createShowcaseBangumiGameGenreLookup,
  parseBangumiGameGenreBindings,
} from '../src/showcase-bangumi-game-genres.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const gameId = '00000000-0000-4000-8000-000000000104';
const schemeId = '00000000-0000-4000-8000-000000000201';
const conceptId = '00000000-0000-4000-8000-000000000202';
const sourceUri = 'https://example.test/bangumi/genre/adventure';
const literal = '视觉小说,冒险/探索';
const infobox = `{{Infobox Game\n|游戏类型=${literal}\n|游戏类型={{Nested|value}}\n|游戏类型=动作\n  continued value\n|游玩人数=1-4人\n}}`;
const record = { id: 91044, type: 4, name: 'Authored Game', name_cn: '测试游戏', infobox };
function subject(
  id: string,
  type: string,
  statements: Record<
    string,
    { rank?: 'normal' | 'preferred' | 'deprecated'; value: { type: 'value'; content: string } }[]
  >,
) {
  const ranked = Object.fromEntries(
    Object.entries(statements).map(([property, values]) => [
      property,
      values.map((statement) => ({ rank: statement.rank ?? 'normal', value: statement.value })),
    ]),
  );
  return {
    subject: { id, type, context: globalContext, statements: ranked },
  } as unknown as ReviewedSubjectRead;
}
const emptyReviewedCandidates = async (): Promise<ReviewedCandidatePage> =>
  ({ candidates: [], next: null }) as unknown as ReviewedCandidatePage;
const statement = (content: string, rank: 'normal' | 'preferred' | 'deprecated' = 'normal') => ({
  rank,
  value: { type: 'value' as const, content },
});

test('ordinary Game conversion preserves the exact infobox literal and withholds unavailable or wrong-scheme bindings', async () => {
  expect(converter_revision).toBe('bangumi@17');
  expect(bangumiGameSourceGenres(record).requirements.map((item) => item.literal)).toEqual([literal]);
  const tooMany = bangumiGameSourceGenres({
    type: 4,
    infobox: `{{Infobox Game\n${Array.from({ length: 17 }, () => `|游戏类型=${literal}`).join('\n')}\n}}`,
  });
  expect(tooMany.requirements).toHaveLength(16);
  expect(tooMany.diagnostics).toContainEqual({
    pointer: '/infobox/游戏类型/16',
    code: 'game_genre_occurrence_limit',
  });
  for (const value of ['a'.repeat(65_537), '界'.repeat(21_846)]) {
    const oversized = bangumiGameSourceGenres({ type: 4, infobox: `{{Infobox Game\n|游戏类型=${value}\n}}` });
    expect(oversized.requirements).toHaveLength(0);
    expect(oversized.diagnostics).toContainEqual({ pointer: '/infobox', code: 'infobox_value_limit' });
  }

  const profile = parseBangumiGameGenreBindings({
    schemeId,
    schemeUri: bangumiGameSourceGenreScheme,
    concepts: [{ literal, id: conceptId, sourceUri }],
  });
  const registration = createSourceRegistration('bangumi');
  const input = { external_id: String(record.id), record_revision: null, record };
  const context = { source: 'bangumi', subjectId: gameId };
  const contextFree = registration.convert(input, context);
  const owner = { source: 'bangumi', external_id: String(record.id) };
  const current = createShowcaseBangumiGameGenreLookup('bangumi', profile, {
    reviewedCandidates: emptyReviewedCandidates,
    async readReviewedSubject(id) {
      return id === schemeId
        ? subject(schemeId, 'skos:ConceptScheme', {
            'schema:url': [{ value: { type: 'value', content: bangumiGameSourceGenreScheme } }],
          })
        : subject(conceptId, 'skos:Concept', {
            'schema:url': [{ value: { type: 'value', content: sourceUri } }],
            'skos:inScheme': [{ value: { type: 'value', content: schemeId } }],
          });
    },
  });
  const resolved = await current.lookup.resolve({
    owner,
    conversion: contextFree,
    signal: new AbortController().signal,
  });
  if ('status' in resolved) throw new Error('Current fixture bindings were unexpectedly unavailable');
  expect(resolved).toEqual({ [bangumiGameSourceGenreReference(literal)]: conceptId });
  const converted = registration.convert(input, { ...context, resolvedReferences: resolved });
  const proposal = converted.proposals.find(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:genre',
  );
  expect(proposal).toMatchObject({
    subject: gameId,
    source: { external_id: String(record.id), converter_revision },
    statement: {
      property: { id: 'schema:genre' },
      value: { type: 'value', content: conceptId },
      references: [
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://bgm.tv/subject/91044' } },
          ],
        },
      ],
    },
  });
  const alternate = registration.convert(input, {
    ...context,
    resolvedReferences: { [bangumiGameSourceGenreReference(literal)]: schemeId },
  });
  const alternateProposal = alternate.proposals.find(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:genre',
  );
  expect(alternateProposal?.key).not.toBe(proposal?.key);
  expect(converted.diagnostics.some((item) => item.code === 'unsupported_game_genre_structure')).toBe(true);

  const wrongScheme = createShowcaseBangumiGameGenreLookup('bangumi', profile, {
    reviewedCandidates: emptyReviewedCandidates,
    async readReviewedSubject(id) {
      return id === schemeId
        ? subject(schemeId, 'skos:ConceptScheme', {
            'schema:url': [{ rank: 'deprecated', value: { type: 'value', content: bangumiGameSourceGenreScheme } }],
          })
        : subject(conceptId, 'skos:Concept', {
            'schema:url': [{ value: { type: 'value', content: sourceUri } }],
            'skos:inScheme': [{ value: { type: 'value', content: schemeId } }],
          });
    },
  });
  const withheld = await wrongScheme.lookup.resolve({
    owner,
    conversion: contextFree,
    signal: new AbortController().signal,
  });
  if ('status' in withheld) throw new Error('Wrong-scheme fixture unexpectedly reported a read outage');
  expect(withheld).toEqual({});
  expect(wrongScheme.diagnostics()).toContainEqual({
    sourceKey: String(record.id),
    path: '/infobox/游戏类型/0',
    code: 'wrong-scheme',
  });
  expect(
    registration
      .convert(input, { ...context, resolvedReferences: withheld })
      .proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:genre'),
  ).toBe(false);

  const unavailable = createShowcaseBangumiGameGenreLookup('bangumi', profile, {
    reviewedCandidates: emptyReviewedCandidates,
    async readReviewedSubject(id) {
      if (id === conceptId) throw new TypeError('current Concept read unavailable');
      return subject(schemeId, 'skos:ConceptScheme', {
        'schema:url': [{ value: { type: 'value', content: bangumiGameSourceGenreScheme } }],
      });
    },
  });
  const failure = await unavailable.lookup.resolve({
    owner,
    conversion: contextFree,
    signal: new AbortController().signal,
  });
  expect(failure).toEqual({ status: 'unavailable', preserveProperties: ['schema:genre'] });
  expect(
    registration
      .convert(input, { ...context, resolvedReferences: {} })
      .proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:genre'),
  ).toBe(false);
});

test('Game genre evidence, shared reads, and verified bindings follow importer runs', async () => {
  const literals = [literal, '动作', '冒险'];
  const ids = literals.map((_, index) => `00000000-0000-4000-8000-00000000021${index}`);
  const uris = literals.map((_, index) => `https://example.test/bangumi/genre/${index}`);
  const runRecord = {
    ...record,
    id: 91045,
    infobox: `{{Infobox Game\n${literals.map((value) => `|游戏类型=${value}`).join('\n')}\n}}`,
  };
  const profile = parseBangumiGameGenreBindings({
    schemeId,
    schemeUri: bangumiGameSourceGenreScheme,
    concepts: literals.map((value, index) => ({ literal: value, id: ids[index]!, sourceUri: uris[index]! })),
  });
  const conversion = createSourceRegistration('bangumi').convert(
    { external_id: String(runRecord.id), record_revision: null, record: runRecord },
    { source: 'bangumi', subjectId: gameId },
  );
  const reads = new Map<string, number>();
  const associations = new Map<string, number>();
  let state: 'retired' | 'current' | 'unavailable' = 'current';
  const adapter = createShowcaseBangumiGameGenreLookup('bangumi', profile, {
    async readReviewedSubject(id) {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      if (state === 'unavailable' && id === ids[0]) throw new TypeError('current Concept read unavailable');
      if (id === schemeId)
        return subject(id, 'skos:ConceptScheme', {
          'schema:url': [statement(bangumiGameSourceGenreScheme, 'preferred')],
        });
      const index = ids.indexOf(id);
      const membershipRank =
        index === 1 && state === 'retired' ? 'deprecated' : index === 2 ? 'preferred' : 'normal';
      return subject(id, 'skos:Concept', {
        'schema:url': [statement(uris[index]!, index === 0 && state === 'retired' ? 'deprecated' : 'normal')],
        'skos:inScheme': [statement(schemeId, membershipRank)],
      });
    },
    async reviewedCandidates(id, query) {
      const key = `${id}\0${query.property}\0${query.target}`;
      associations.set(key, (associations.get(key) ?? 0) + 1);
      return { candidates: [], next: null } as unknown as ReviewedCandidatePage;
    },
  });
  const lookup = (signal: AbortSignal, externalId = String(runRecord.id)) =>
    adapter.lookup.resolve({
      owner: { source: 'bangumi', external_id: externalId },
      conversion,
      signal,
    });
  const idsFor = () => literals.map((value) => adapter.bindingFor(value)?.id);
  const refs = () =>
    Object.fromEntries(literals.map((value, index) => [bangumiGameSourceGenreReference(value), ids[index]]));
  const expectReads = (count: number) => expect([...reads.values()]).toEqual(Array(4).fill(count));

  const currentSignal = new AbortController().signal;
  const firstCurrent = await lookup(currentSignal);
  expect(await lookup(currentSignal, '91046')).toEqual(firstCurrent);
  expect(firstCurrent).toEqual(refs());
  expect(idsFor()).toEqual(ids);
  expectReads(1);

  state = 'retired';
  const retiredSignal = new AbortController().signal;
  const retired = await lookup(retiredSignal);
  expect(await lookup(retiredSignal, '91046')).toEqual(retired);
  expect(retired).toEqual({ [bangumiGameSourceGenreReference(literals[2]!)]: ids[2] });
  expect(idsFor()).toEqual([undefined, undefined, ids[2]]);
  expectReads(2);
  expect([...associations.values()]).toEqual([1]);

  state = 'current';
  const restored = await lookup(new AbortController().signal);
  expect(restored).toEqual(refs());
  expect(idsFor()).toEqual(ids);
  expectReads(3);

  state = 'unavailable';
  const unavailableSignal = new AbortController().signal;
  const unavailable = await lookup(unavailableSignal);
  expect(await lookup(unavailableSignal, '91046')).toEqual(unavailable);
  expect(unavailable).toEqual({
    status: 'unavailable',
    preserveProperties: ['schema:genre'],
    resolvedReferences: Object.fromEntries(
      literals.slice(1).map((value, index) => [bangumiGameSourceGenreReference(value), ids[index + 1]]),
    ),
  });
  expect(idsFor()).toEqual([undefined, ids[1], ids[2]]);
  expectReads(4);

  state = 'current';
  expect(await lookup(new AbortController().signal)).toEqual(restored);
  expect(adapter.bindingFor(literal)?.id).toBe(ids[0]);
  expect(adapter.diagnostics()).toEqual([]);
  expectReads(5);
});
