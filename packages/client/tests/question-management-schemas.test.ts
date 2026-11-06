import { expect, expectTypeOf, test } from 'bun:test';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import {
  QuestionManagementResponseSchema,
  RatingQuestionLabelHistorySchema,
  type QuestionCreateResult,
  type QuestionLabelHistory,
  type QuestionLabelResult,
  type QuestionLifecycleResult,
  type QuestionManagementPage,
} from '@rezics/client';

const realmId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702001';
const viewerId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702002';
const questionId = '019a1b2c-3d4e-7f00-8a00-5ab1ec702102';

// The management page the installed route returns for a retired selected question.
const management = {
  viewer: { accountId: viewerId },
  realmId,
  directory: { ratingQuestions: [], next: null },
  actions: { create: { method: 'POST', href: `/v1/realms/${realmId}/rating-questions` } },
  selected: {
    question: {
      id: questionId,
      realmId,
      meaning: 'Judge translation accuracy independently of enjoyment of the original work.',
      canonicalLabel: 'Translation accuracy',
      label: 'Translation clarity',
      labelRevision: 2,
      revision: 1,
      grain: 'release',
      scale: { min: 0, max: 20, displayStep: 2 },
      lifecycle: { state: 'retired', revision: 2 },
    },
    readback: `/v1/rating-questions/${questionId}`,
    history: `/v1/rating-questions/${questionId}/labels`,
    actions: {
      caption: { method: 'PUT', href: `/v1/rating-questions/${questionId}/label`, expectedLabelRevision: 2 },
      lifecycle: { method: 'POST', href: `/v1/rating-questions/${questionId}/$restore`, expectedLifecycleRevision: 2 },
    },
  },
};

// The caption history page the installed label-history route returns.
const history = {
  labels: [
    {
      questionId,
      labelRevision: 1,
      label: 'Translation accuracy',
      at: null,
      author: { id: viewerId, kind: 'actor', state: 'deleted' },
    },
  ],
  next: null,
};

test('the installed package validates the management page it publishes, and no other shape', () => {
  expect(Value.Check(QuestionManagementResponseSchema(), management)).toBe(true);
  expect(Value.Check(QuestionManagementResponseSchema(), { ...management, unlisted: true })).toBe(false);
});

test('the installed package validates the caption history it publishes, and no other shape', () => {
  expect(Value.Check(RatingQuestionLabelHistorySchema, history)).toBe(true);
  expect(Value.Check(RatingQuestionLabelHistorySchema, { ...history, unlisted: true })).toBe(false);
});

test('the published management schema describes the installed management page', () => {
  type Published = Static<ReturnType<typeof QuestionManagementResponseSchema>>;
  expectTypeOf<Published>().toEqualTypeOf<QuestionManagementPage>();
});

test('the published caption-history schema describes the installed history page', () => {
  type Published = Static<typeof RatingQuestionLabelHistorySchema>;
  expectTypeOf<Published>().toEqualTypeOf<QuestionLabelHistory>();
});

test('create, caption and lifecycle results keep the mounted command shapes', () => {
  expectTypeOf<QuestionCreateResult>().toMatchTypeOf<{
    id: string;
    revision: number;
    label: string;
    grain: 'work' | 'release' | 'episode' | 'character';
    scale: { min: number; max: number; displayStep: number };
  }>();
  expectTypeOf<QuestionLabelResult>().toEqualTypeOf<{
    questionId: string;
    labelRevision: number;
    label: string;
  }>();
  expectTypeOf<QuestionLifecycleResult>().toEqualTypeOf<{
    questionId: string;
    lifecycle: { state: 'active' | 'retired'; revision: number };
  }>();
});
