import { expect, test } from 'bun:test';
import { ProblemError } from '../../src/http/problem.ts';
import { completeSuggestionWorkContext, type SuggestionWorkContext } from '../../src/search/suggestion-context.ts';
import { projectNativeSuggestionWorkContext } from '../../src/search/suggestion-context-native.ts';
import type { WorkContext } from '../../src/search/work-context.ts';

const subjectId = '123e4567-e89b-12d3-a456-426614174000';
const creatorId = '123e4567-e89b-12d3-a456-426614174001';
const workId = '123e4567-e89b-12d3-a456-426614174002';
const row = { id: subjectId, type: 'schema:Book', labels: { en: 'Shared title' } };

test('one current batch preserves the qualified role, partial date and disclosed overflow without a destination', async () => {
  let reads = 0;
  let completed = false;
  const context: SuggestionWorkContext = {
    subjectId,
    status: 'available',
    creator: {
      id: creatorId,
      label: { value: 'Ursula K. Le Guin', language: 'en' },
      property: 'schema:author',
      role: { value: 'Author', language: 'en' },
    },
    relation: {
      kind: 'work',
      id: workId,
      label: { value: 'Earthsea', language: 'en' },
      date: { state: 'value', property: 'schema:datePublished', value: '1968-06', precision: 'month' },
    },
    overflow: true,
  };
  const page = await completeSuggestionWorkContext(
    { subjects: [row], as_of: '2026-11-04T00:00:00Z' },
    {
      languages: ['en'],
      deadline: Date.now() + 10_000,
      reader: async ({ subjectIds, languages }) => {
        reads++;
        expect(subjectIds).toEqual([subjectId]);
        expect(languages).toEqual(['en']);
        return {
          contexts: [context],
          async isCurrent() {
            expect(completed).toBe(true);
            return true;
          },
        };
      },
      async complete(result) {
        completed = true;
        expect(result.subjects[0]?.workContext).toEqual(context);
      },
    },
  );

  expect(reads).toBe(1);
  expect(page.subjects[0]?.workContext).toEqual(context);
  expect(page.subjects[0]?.workContext).not.toHaveProperty('count');
  expect(page.subjects[0]?.workContext).not.toHaveProperty('destination');
  for (const [precision, accepted, rejected] of [
    ['year', '0000 1968', '+1968 -1968 10000 1968-06'],
    ['month', '0000-02 1968-06', '1968 1968-00 1968-13 1968-06-01'],
    [
      'day',
      '0000-02-29 2000-02-29',
      '1900-02-29 2000-04-31 2000-01-00 2000-00-01 +2000-02-29 10000-01-01 2000-01-01T00:00:00Z',
    ],
  ] as const) {
    for (const value of `${accepted} ${rejected}`.split(' ')) {
      const date = { state: 'value' as const, property: 'schema:datePublished', value, precision };
      const candidateContext = { ...context, relation: { ...context.relation!, date } };
      const result = completeSuggestionWorkContext(
        { subjects: [row], as_of: page.as_of },
        {
          languages: ['en'],
          deadline: Date.now() + 10_000,
          reader: async () => ({ contexts: [candidateContext], isCurrent: async () => true }),
        },
      );
      if (accepted.split(' ').includes(value))
        expect((await result).subjects[0]?.workContext).toEqual(candidateContext);
      else await expect(result).rejects.toMatchObject({ code: 'index_not_ready' });
    }
  }
});

test('native work projection keeps exact creator role and same-statement partial date, while concealed identity stays withheld', () => {
  const statement = (statementId: string, property: string, label: string, id: string, creatorRole: boolean) => ({
    statementId,
    sourceId: subjectId,
    direction: 'outgoing' as const,
    property: { id: property, labels: { en: label } },
    revision: 1,
    release: `sha256:${'a'.repeat(64)}`,
    rank: 'normal' as const,
    value: {
      state: 'value' as const,
      kind: 'item' as const,
      id,
      originalId: id,
      type: { id: creatorRole ? 'schema:Person' : 'schema:Book', labels: { en: creatorRole ? 'Person' : 'Book' } },
      labels: { en: creatorRole ? 'Mary Shelley' : 'Frankenstein' },
    },
    qualifiers: creatorRole
      ? { state: 'empty' as const }
      : {
          state: 'current' as const,
          items: [
            {
              property: { id: 'schema:datePublished', labels: { en: 'Publication date' } },
              value: {
                state: 'value' as const,
                kind: 'time' as const,
                calendar: 'gregorian' as const,
                year: 1818,
                month: 1,
              },
            },
          ],
        },
  });
  const creators = [
    statement(creatorId, 'schema:author', 'Author', creatorId, true),
    statement(workId, 'schema:author', 'Author', creatorId, true),
    statement('123e4567-e89b-12d3-a456-426614174004', 'schema:author', 'Author', creatorId, true),
  ];
  const native = {
    state: 'current' as const,
    subjectId,
    type: { id: 'schema:Book', labels: { en: 'Book' } },
    kind: 'work' as const,
    creators: { state: 'current' as const, items: creators, overflow: true },
    relations: {
      state: 'current' as const,
      items: [statement('123e4567-e89b-12d3-a456-426614174005', 'schema:hasPart', 'Part of', workId, false)],
      overflow: false,
    },
    dates: { state: 'unsupported' as const },
  } satisfies WorkContext;
  const release = {
    types: {
      'schema:Book': { bases: ['schema:CreativeWork'] },
      'schema:Person': { bases: [] },
    },
    properties: { 'schema:datePublished': { datatype: 'time' } },
  } as unknown as import('@rezics/definitions').Release;

  expect(projectNativeSuggestionWorkContext(subjectId, { id: subjectId, workContext: native }, release)).toEqual({
    subjectId,
    status: 'available',
    creator: {
      id: creatorId,
      label: { value: 'Mary Shelley', language: 'en' },
      property: 'schema:author',
      role: { value: 'Author', language: 'en' },
    },
    relation: {
      kind: 'work',
      id: workId,
      label: { value: 'Frankenstein', language: 'en' },
      date: { state: 'value', property: 'schema:datePublished', value: '1818-01', precision: 'month' },
    },
    overflow: true,
  });
  expect(
    projectNativeSuggestionWorkContext(
      subjectId,
      { id: subjectId, workContext: { ...native, creators: { state: 'withheld' } } },
      release,
    ),
  ).toEqual({ subjectId, status: 'withheld' });
  let changedIdentity: unknown;
  try {
    projectNativeSuggestionWorkContext(subjectId, { id: creatorId }, release);
  } catch (error) {
    changedIdentity = error;
  }
  expect(changedIdentity).toMatchObject({ code: 'search_restart_required' });
});

test('missing context is unavailable and mismatched or duplicate identities cannot complete a page', async () => {
  const unavailable = await completeSuggestionWorkContext(
    { subjects: [row], as_of: '2026-11-04T00:00:00Z' },
    {
      languages: ['en'],
      deadline: Date.now() + 10_000,
    },
  );
  expect(unavailable.subjects[0]?.workContext).toEqual({ subjectId, status: 'unavailable' });

  const concealed: SuggestionWorkContext = { subjectId, status: 'withheld' };
  await expect(
    completeSuggestionWorkContext(
      { subjects: [row], as_of: '2026-11-04T00:00:00Z' },
      {
        languages: ['en'],
        deadline: Date.now() + 10_000,
        reader: async () => ({
          contexts: [concealed],
          async isCurrent() {
            return true;
          },
        }),
      },
    ),
  ).resolves.toMatchObject({ subjects: [{ workContext: concealed }] });

  for (const contexts of [[{ ...concealed, subjectId: creatorId }], [concealed, concealed]]) {
    await expect(
      completeSuggestionWorkContext(
        { subjects: [row], as_of: '2026-11-04T00:00:00Z' },
        {
          languages: ['en'],
          deadline: Date.now() + 10_000,
          reader: async () => ({
            contexts,
            async isCurrent() {
              return true;
            },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'index_not_ready' });
  }
});

test('changed context identity retires the completed page before it can succeed', async () => {
  let completeCalled = false;
  await expect(
    completeSuggestionWorkContext(
      { subjects: [row], as_of: '2026-11-04T00:00:00Z' },
      {
        languages: ['en'],
        deadline: Date.now() + 10_000,
        reader: async () => ({
          contexts: [{ subjectId, status: 'withheld' }],
          async isCurrent() {
            return false;
          },
        }),
        async complete() {
          completeCalled = true;
        },
      },
    ),
  ).rejects.toBeInstanceOf(ProblemError);
  expect(completeCalled).toBe(true);
});
