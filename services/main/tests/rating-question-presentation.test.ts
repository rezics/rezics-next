import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import {
  readDisplayRatingQuestion,
  selectQuestionPresentation,
} from '../src/modules/rating/question-presentation-read.ts';
import { FusekiReadBudgetExceeded } from '../src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { ratingQuestionPresentationPermission } from '../src/modules/access/rating-question-presentation.ts';
import {
  checkedQuestionPresentation,
  questionPresentationAction,
  questionPresentationDigest,
  questionPresentationStateSchema,
  type QuestionPresentationState,
} from '../src/modules/rating/question-presentation-schema.ts';
import { ratingConfigurationAction } from '../src/modules/access/realm-roles-rating.ts';
import { platformAdministratorAction } from '../src/modules/access/platform-administrator.ts';
import { receiptFamilyFor } from '../src/modules/access/receipt-families.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const authored = { context: native(), question: 'How much did you enjoy it?', language: 'en' };
const state = (
  language: string,
  question = 'A translated question?',
): QuestionPresentationState => ({
  context: authored.context,
  language,
  question,
  reviewStatus: 'reviewed',
  source: 'https://example.test/question',
  licence: 'https://creativecommons.org/licenses/by/4.0/',
});
const row = (language: string, question?: string) => ({
  component: native(),
  revision: native(),
  state: state(language, question),
});

test('Question drafting and review select independent Realm grants', () => {
  expect(ratingQuestionPresentationPermission('rating.question-presentation.change')).toBe(
    'rating.configure',
  );
  expect(ratingQuestionPresentationPermission('rating.question-presentation.review')).toBe(
    'rating.question-presentation.review',
  );
});

test('Question display reads use LIMIT 65 and refuse an overflowing review index', async () => {
  let query = '';
  const env = {
    fuseki: {
      query: async (sparql: string) => {
        query = sparql;
        return { results: { bindings: Array.from({ length: 65 }, () => ({})) } };
      },
    },
  } as unknown as WorkActivationEnvironment;
  await expect(readDisplayRatingQuestion(env, authored, ['fr'])).rejects.toBeInstanceOf(
    FusekiReadBudgetExceeded,
  );
  expect(query).toContain('LIMIT 65');
  expect(query).toContain('questionPresentationReviewedHead');
});

test('Rating question selection uses reader order, arbitrary BCP 47 languages and authored fallback', () => {
  const rows = [
    row('ja', '作品を楽しみましたか？'),
    row('ar', 'هل استمتعت بهذا العمل؟'),
    row('eo', 'Ĉu vi ĝuis ĝin?'),
  ];
  expect(selectQuestionPresentation(authored, rows, ['eo'])).toMatchObject({
    language: 'eo',
    basis: 'requested',
    reviewStatus: 'reviewed',
    fallback: null,
  });
  expect(selectQuestionPresentation(authored, rows, ['ar', 'ja'])).toMatchObject({
    language: 'ar',
    direction: 'rtl',
  });
  expect(selectQuestionPresentation(authored, rows, ['ko'])).toMatchObject({
    value: authored.question,
    language: 'en',
    reviewStatus: 'authored',
    presentation: null,
    fallback: { requestedLanguages: ['ko'], usedLanguage: 'en', conversion: null },
  });
  expect(selectQuestionPresentation(authored, rows, [])).toMatchObject({
    value: authored.question,
    language: 'en',
  });
});
test('Rating question script fallback is explicit and a later same-script preference wins', () => {
  const rows = [row('zh-Hans', '你喜欢这部作品吗？'), row('ja', '作品を楽しみましたか？')];
  expect(selectQuestionPresentation(authored, rows, ['zh-Hant'])).toMatchObject({
    language: 'zh-Hans',
    basis: 'other-script',
    fallback: {
      reason: 'script-fallback',
      requestedScript: 'Hant',
      usedScript: 'Hans',
      crossedScript: true,
      conversion: null,
    },
  });
  expect(selectQuestionPresentation(authored, rows, ['zh-Hant', 'ja'])).toMatchObject({
    language: 'ja',
    basis: 'requested',
  });
  expect(selectQuestionPresentation(authored, [row('zh-Hant')], ['zh-TW'])).toMatchObject({
    language: 'zh-Hant',
    basis: 'same-script',
  });
  expect(() => selectQuestionPresentation(authored, [row('en')], ['en'])).toThrow('ambiguous');
  expect(() => selectQuestionPresentation(authored, [row('eo'), row('eo')], ['eo'])).toThrow(
    'ambiguous',
  );
});
test('Rating question write validation separates review authority and immutable identity', () => {
  for (const language of ['fr', 'zh-Hant', 'sr-Latn', 'eo', 'x-question', 'i-klingon']) {
    expect(Value.Check(questionPresentationStateSchema, state(language))).toBe(true);
    expect(checkedQuestionPresentation(state(language)).language).toBeTruthy();
  }
  for (const language of ['', 'en ; INSERT', 'ja\n', 'ar--Arab'])
    expect(() => checkedQuestionPresentation(state(language))).toThrow();
  expect(() =>
    checkedQuestionPresentation({ ...state('fr'), source: 'javascript:run()' }),
  ).toThrow();
  expect(() => checkedQuestionPresentation({ ...state('fr'), unexpected: true })).toThrow();
  expect(questionPresentationAction(state('fr'))).toBe('rating.question-presentation.review');
  expect(questionPresentationAction({ reviewStatus: 'draft' })).toBe(
    'rating.question-presentation.change',
  );
  expect(() => questionPresentationDigest(undefined, native(), state('fr'))).toThrow();
  expect(questionPresentationDigest(undefined, null, state('fr'))).not.toBe(
    questionPresentationDigest(undefined, null, { ...state('fr'), reviewStatus: 'draft' }),
  );
  for (const action of [
    'rating.context.create',
    'rating.context.policy.set',
    'rating.question-presentation.change',
    'rating.question-presentation.review',
  ]) {
    expect(ratingConfigurationAction(action)).toBe(true);
  }
  expect(ratingConfigurationAction('rating.observation.set')).toBe(false);
  for (const action of [
    'rating.question-presentation.change',
    'rating.question-presentation.review',
  ]) {
    expect(platformAdministratorAction(action, `rating:presentation:${authored.context}`)).toBe(
      true,
    );
    expect(platformAdministratorAction(action, `semantic:edit:${authored.context}`)).toBe(false);
    expect(receiptFamilyFor(action)).toBe('rating-question-presentation-change');
  }
});
