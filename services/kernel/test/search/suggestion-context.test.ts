import { expect, test } from 'bun:test';
import { ProblemError } from '../../src/http/problem.ts';
import { completeSuggestionWorkContext, type SuggestionWorkContext } from '../../src/search/suggestion-context.ts';

const subjectId = '123e4567-e89b-12d3-a456-426614174000';
const creatorId = '123e4567-e89b-12d3-a456-426614174001';
const workId = '123e4567-e89b-12d3-a456-426614174002';
const overflowId = '123e4567-e89b-12d3-a456-426614174003';
const row = { id: subjectId, type: 'schema:Book', labels: { en: 'Shared title' } };

test('one current batch preserves the qualified role, partial date and admitted overflow destination', async () => {
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
    overflow: { destination: { id: overflowId, kind: 'subject' } },
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
});

test('missing context is unavailable and mismatched or duplicate identities cannot complete a page', async () => {
  const unavailable = await completeSuggestionWorkContext({ subjects: [row], as_of: '2026-11-04T00:00:00Z' }, {
    languages: ['en'],
    deadline: Date.now() + 10_000,
  });
  expect(unavailable.subjects[0]?.workContext).toEqual({ subjectId, status: 'unavailable' });

  const concealed: SuggestionWorkContext = { subjectId, status: 'withheld' };
  await expect(
    completeSuggestionWorkContext({ subjects: [row], as_of: '2026-11-04T00:00:00Z' }, {
      languages: ['en'],
      deadline: Date.now() + 10_000,
      reader: async () => ({ contexts: [concealed], async isCurrent() { return true; } }),
    }),
  ).resolves.toMatchObject({ subjects: [{ workContext: concealed }] });

  for (const contexts of [
    [{ ...concealed, subjectId: creatorId }],
    [concealed, concealed],
  ]) {
    await expect(
      completeSuggestionWorkContext({ subjects: [row], as_of: '2026-11-04T00:00:00Z' }, {
        languages: ['en'],
        deadline: Date.now() + 10_000,
        reader: async () => ({ contexts, async isCurrent() { return true; } }),
      }),
    ).rejects.toMatchObject({ code: 'index_not_ready' });
  }
});

test('changed context identity retires the completed page before it can succeed', async () => {
  let completeCalled = false;
  await expect(
    completeSuggestionWorkContext({ subjects: [row], as_of: '2026-11-04T00:00:00Z' }, {
      languages: ['en'],
      deadline: Date.now() + 10_000,
      reader: async () => ({
        contexts: [{ subjectId, status: 'withheld' }],
        async isCurrent() { return false; },
      }),
      async complete() {
        completeCalled = true;
      },
    }),
  ).rejects.toBeInstanceOf(ProblemError);
  expect(completeCalled).toBe(true);
});
