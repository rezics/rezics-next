import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  createHomeQuestionChoices,
  readHomeQuestion,
  readHomeQuestionPage,
  type HomeQuestion,
} from '../src/features/pages/home-feed-questions';

const questionId = '00000000-0000-7000-8000-000000000001';
const globalQuestion = {
  id: questionId,
  revision: 1,
  label: 'Overall impression',
  grain: 'work' as const,
  scale: { min: 0, max: 100, displayStep: 5 },
};

function clientFor(body: unknown) {
  const requests: Request[] = [];
  return {
    requests,
    client: createKernelClient('https://kernel.example', {
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(body);
      },
    }),
  };
}

test('Global question directory accepts one generated bounded page with its real continuation', async () => {
  const { client, requests } = clientFor({ ratingQuestions: [globalQuestion], next: 'next-native-page' });

  expect(await readHomeQuestionPage(client)).toEqual({
    status: 'ready',
    page: { ratingQuestions: [globalQuestion], next: 'next-native-page' },
  });
  expect(new URL(requests[0]!.url).searchParams.get('limit')).toBe('20');
  expect(new URL(requests[0]!.url).searchParams.has('realm')).toBe(false);
});

test('generated Realm lifecycle fields remain validated and cannot become a Global selection', async () => {
  const retiredRealmQuestion = {
    ...globalQuestion,
    realmId: '00000000-0000-7000-8000-000000000002',
    canonicalLabel: 'Canonical label',
    labelRevision: 2,
    meaning: 'A Realm-specific meaning',
    lifecycle: { state: 'retired' as const, revision: 3 },
  };
  const page = clientFor({ ratingQuestions: [retiredRealmQuestion], next: null });
  const point = clientFor(retiredRealmQuestion);

  expect(await readHomeQuestionPage(page.client)).toEqual({
    status: 'unavailable',
    code: 'invalid_question_response',
  });
  expect(
    await readHomeQuestionPage(
      clientFor({ ratingQuestions: [{ ...globalQuestion, lifecycle: { state: 'retired', revision: 3 } }], next: null })
        .client,
    ),
  ).toEqual({ status: 'unavailable', code: 'invalid_question_response' });
  expect(await readHomeQuestion(point.client, questionId)).toEqual({ status: 'lost', code: 'question_retired' });
  expect(await readHomeQuestionPage(clientFor({ ratingQuestions: [], next: 'more' }).client)).toEqual({
    status: 'ready',
    page: { ratingQuestions: [], next: 'more' },
  });
});

test('an active exact Realm point stays refused by Global Home', async () => {
  const { client } = clientFor({
    ...globalQuestion,
    realmId: '00000000-0000-7000-8000-000000000002',
    canonicalLabel: 'Canonical label',
    labelRevision: 2,
    meaning: 'A Realm-specific meaning',
    lifecycle: { state: 'active', revision: 1 },
  });

  expect(await readHomeQuestion(client, questionId)).toEqual({ status: 'denied', code: 'question_not_global' });
});

test('operational retry keeps its exact directory cursor while stale traversal needs a cursorless restart', async () => {
  const attempts: (string | undefined)[] = [];
  let cursorReads = 0;
  const selected: HomeQuestion = globalQuestion;
  const choices = createHomeQuestionChoices(
    async (cursor) => {
      attempts.push(cursor);
      if (cursor === 'opaque-frontier' && ++cursorReads === 1)
        return { status: 'unavailable', code: 'dependency_unavailable' };
      if (cursor === 'invalidated-frontier') return { status: 'restart', code: 'stale_cursor' };
      return { status: 'ready', page: { ratingQuestions: [selected], next: cursor ? null : 'opaque-frontier' } };
    },
    async (id) => ({ status: 'ready', question: { ...selected, id } }),
    () => undefined,
  );

  await choices.select(selected);
  await choices.load();
  await choices.load('opaque-frontier');
  expect(choices.retryCursor()).toBe('opaque-frontier');
  await choices.load(choices.retryCursor());
  expect(attempts).toEqual([undefined, 'opaque-frontier', 'opaque-frontier']);
  expect(choices.snapshot().selected?.id).toBe(questionId);

  await choices.load('invalidated-frontier');
  expect(choices.retryCursor()).toBeUndefined();
  await choices.load(choices.retryCursor());
  expect(attempts.at(-1)).toBeUndefined();
  expect(choices.snapshot().selected?.id).toBe(questionId);
});
