import { beforeAll, expect, test } from 'bun:test';
import { Compile } from 'typebox/schema';
import { AnswerRecordValidator, answerPersonas, answerRecord,
  type AnswerContract, type AnswerRecord, type AnswerSample } from '../../../scripts/api/answer-record.ts';
import { buildMainOpenApi } from '../../../scripts/api/generate.ts';
import { realmThread, realmThreadsPage } from '../../../services/main/src/modules/realm-reply/thread-contract.ts';

const uuid = '00000000-0000-4000-8000-000000000001';
const id = `https://rezics.com/id/${uuid}`;
const sourcePosition = { dataEpoch: 'fixture', sequence: '1' };
const work = { id, title: { value: 'Original discussion fixture', language: 'en',
  direction: 'ltr', basis: 'requested' },
  cover: { kind: 'fallback', policy: 'fixture', key: uuid, resourceType: 'work' } };
const reply = (value: unknown) => ({ reply: id, placement: id, parent: null,
  author: { id, name: 'Original contributor', handle: null },
  time: '2026-10-14T00:00:00.000Z', language: 'en', revisionId: uuid,
  title: null, body: 'Original independently credited reply.',
  vote: { score: 0, value, revision: null, open: true } });

const surfaces = [
  { name: 'thread replies', path: `/v1/realms/${uuid}/threads/${uuid}`, pointer: '/items/0/vote/value',
    schema: Compile(realmThread), answer: (value: unknown) => ({
      profile: 'realm-thread-v1', realm: id, thread: id, focus: id, sort: 'best', work, rootRevision: id,
      ancestors: [], items: [reply(value)], continuations: [], complete: true, sourcePosition,
    }) },
  { name: 'thread ancestors', path: `/v1/realms/${uuid}/threads/${uuid}`, pointer: '/ancestors/0/vote/value',
    schema: Compile(realmThread), answer: (value: unknown) => ({
      profile: 'realm-thread-v1', realm: id, thread: id, focus: id, sort: 'best', work, rootRevision: id,
      ancestors: [reply(value)], items: [], continuations: [], complete: true, sourcePosition,
    }) },
  { name: 'thread summaries', path: `/v1/realms/${uuid}/threads`, pointer: '/items/0/vote/value',
    schema: Compile(realmThreadsPage), answer: (value: unknown) => ({
      profile: 'realm-threads-v1', realm: id, sort: 'best', window: 'all',
      items: [{ reply: id, placement: id, work, author: { id, name: 'Original contributor', handle: null },
        time: '2026-10-14T00:00:00.000Z', language: 'en', title: 'Original discussion', excerpt: 'Original text.',
        vote: { score: 0, value, revision: null, open: true }, replies: { value: 0, kind: 'exact' } }],
      nextCursor: null, sourcePosition, count: { value: 1, kind: 'exact-page', total: null },
    }) },
] as const;

let validator: AnswerRecordValidator;
beforeAll(async () => {
  validator = new AnswerRecordValidator(JSON.parse(await buildMainOpenApi()) as AnswerContract);
}, 60_000);

function record(surface: typeof surfaces[number], value: unknown): AnswerRecord {
  const sample: AnswerSample = { label: surface.name, method: 'GET', path: surface.path,
    operationId: validator.operationId('GET', surface.path), status: 200,
    answer: surface.answer(value), headers: { 'content-type': 'application/json' } };
  // These are unit contract inputs, never recorded or published outcome answers.
  return answerRecord('zone/attached-realm-discussion',
    Object.fromEntries(answerPersonas.map(persona => [persona, [sample]])) as AnswerRecord['personas']);
}

for (const surface of surfaces) {
  for (const value of [-1, 0, 1]) {
    test(`${surface.name}: generated answer contract accepts numeric vote ${value}`, () => {
      expect(surface.schema.Check(surface.answer(value))).toBe(true);
      const input = record(surface, value);
      const before = JSON.stringify(input);
      expect(validator.validate(input)).toEqual(input);
      expect(JSON.stringify(input)).toBe(before);
    });
  }
  for (const value of ['-1', '0', '1', -2, 2, 0.5, null, true]) {
    test(`${surface.name}: authored and generated contracts reject vote ${JSON.stringify(value)}`, () => {
      expect(surface.schema.Check(surface.answer(value))).toBe(false);
      expect(() => validator.validate(record(surface, value)))
        .toThrow(`/personas/visitor/0/answer${surface.pointer}`);
    });
  }
}
