import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
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
import { platformAdministratorTargetAllowed } from '../src/modules/access/platform-administrator.ts';
import type { PlatformPermission } from '../src/modules/access/platform-permissions.ts';
import { receiptFamilyFor } from '../src/modules/access/receipt-families.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;

function seededPlatformGrants(): PlatformPermission[] {
  const sql = readFileSync(
    new URL('../migrations/access/1290_platform_grants.sql', import.meta.url),
    'utf8',
  );
  const values = sql.slice(
    sql.indexOf('SELECT * FROM (VALUES'),
    sql.indexOf(') AS permissions(action,scope)'),
  );
  return [...values.matchAll(/\('([^']+)','([^']+)'\)/g)].map((match, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    action: match[1]!,
    scope_id: match[2]!,
    generation: '1',
    valid_until: null,
    witness: 'seed',
  }));
}

function seededGrantClient(grants: readonly PlatformPermission[]): PoolClient {
  return {
    query: async (sql: string) => {
      if (sql.includes('access.read_platform_permissions')) return { rows: grants };
      throw new Error(`unexpected admission query: ${sql}`);
    },
  } as unknown as PoolClient;
}
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
test('Rating question write validation separates review authority and immutable identity', async () => {
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
  // Retiring is a draft of an existing presentation with its own digest.
  const draft = { ...state('fr'), reviewStatus: 'draft' as const },
    [target, head] = [native(), native()];
  expect(questionPresentationDigest(target, head, draft, true)).not.toBe(
    questionPresentationDigest(target, head, draft),
  );
  expect(questionPresentationDigest(target, head, draft, false)).toBe(
    questionPresentationDigest(target, head, draft),
  );
  expect(() => questionPresentationDigest(undefined, null, draft, true)).toThrow();
  expect(() => questionPresentationDigest(target, head, state('fr'), true)).toThrow();
  for (const action of [
    'rating.context.create',
    'rating.context.policy.set',
    'rating.question-presentation.change',
    'rating.question-presentation.review',
  ]) {
    expect(ratingConfigurationAction(action)).toBe(true);
  }
  expect(ratingConfigurationAction('rating.observation.set')).toBe(false);
  const grants = seededPlatformGrants();
  for (const action of [
    'rating.question-presentation.change',
    'rating.question-presentation.review',
  ] as const) {
    expect(
      grants.filter((grant) => grant.action === `platform:resource:${action}`).map((grant) => grant.scope_id),
    ).toEqual(['rating:presentation:*']);
  }
  const client = seededGrantClient(grants);
  const actor = native();
  const principal = randomUUID();
  let asks = 0;
  const graph = {
    query: async () => {
      asks += 1;
      return { boolean: true };
    },
  };
  for (const action of [
    'rating.question-presentation.change',
    'rating.question-presentation.review',
  ] as const) {
    const before = asks;
    expect(
      await platformAdministratorTargetAllowed(
        client,
        graph,
        principal,
        actor,
        action,
        `rating:presentation:${authored.context}`,
      ),
    ).toBe(true);
    expect(asks).toBe(before + 1);
    expect(
      await platformAdministratorTargetAllowed(
        client,
        graph,
        principal,
        actor,
        action,
        `semantic:edit:${authored.context}`,
      ),
    ).toBe(false);
    // The seeded presentation grant does not cover a semantic scope, so admission
    // refuses before the question-target lookup.
    expect(asks).toBe(before + 1);
    expect(receiptFamilyFor(action)).toBe('rating-question-presentation-change');
  }
});
