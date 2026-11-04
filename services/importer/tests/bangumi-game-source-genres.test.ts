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
function subject(id: string, type: string, statements: Record<string, { value: { type: 'value'; content: string } }[]>) {
  return {
    subject: { id, type, context: globalContext, statements },
  } as unknown as ReviewedSubjectRead;
}
const emptyReviewedCandidates = async (): Promise<ReviewedCandidatePage> =>
  ({ candidates: [], next: null }) as unknown as ReviewedCandidatePage;

test('ordinary Game conversion preserves the exact infobox literal and withholds unavailable or wrong-scheme bindings', async () => {
  expect(converter_revision).toBe('bangumi@13');
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
  const resolved = await current.lookup.resolve({ owner, conversion: contextFree, signal: new AbortController().signal });
  if ('status' in resolved) throw new Error('Current fixture bindings were unexpectedly unavailable');
  expect(resolved).toEqual({ [bangumiGameSourceGenreReference(literal)]: conceptId });
  const converted = registration.convert(input, { ...context, resolvedReferences: resolved });
  const proposal = converted.proposals.find(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:genre',
  );
  expect(proposal).toMatchObject({
    subject: gameId,
    source: { external_id: String(record.id), converter_revision: 'bangumi@13' },
    statement: {
      property: { id: 'schema:genre' },
      value: { type: 'value', content: conceptId },
      references: [
        {
          parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://bgm.tv/subject/91044' } }],
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
            'schema:url': [{ value: { type: 'value', content: 'https://example.test/wrong-scheme' } }],
          })
        : subject(conceptId, 'skos:Concept', {
            'schema:url': [{ value: { type: 'value', content: sourceUri } }],
            'skos:inScheme': [{ value: { type: 'value', content: schemeId } }],
          });
    },
  });
  const withheld = await wrongScheme.lookup.resolve({ owner, conversion: contextFree, signal: new AbortController().signal });
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
  const failure = await unavailable.lookup.resolve({ owner, conversion: contextFree, signal: new AbortController().signal });
  expect(failure).toEqual({ status: 'unavailable', preserveProperties: ['schema:genre'] });
  expect(
    registration
      .convert(input, { ...context, resolvedReferences: {} })
      .proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:genre'),
  ).toBe(false);
});
