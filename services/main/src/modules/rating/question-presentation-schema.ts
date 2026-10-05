import { t } from 'elysia';
import { canonicalLanguage } from '../display-language/select.ts';
import { languageTagSchema, displayLanguageBasis } from '../display-language/schema.ts';
import { checkedNativeIri } from '../semantic/schema.ts';
import { SemanticChangeRejected } from '../semantic/command.ts';
import { hash } from '../work/activate.ts';
import { readId } from '../work/read-contract.ts';
import { ratingQuestionPresentationActions } from '../access/rating-question-presentation.ts';

export const QUESTION_PRESENTATION_PROFILE = 'rating-question-presentation-v1';
export const QUESTION_PRESENTATION_PROFILE_IRI = `https://rezics.com/definition/${QUESTION_PRESENTATION_PROFILE}`;
export const QUESTION_PRESENTATION_STORAGE_PROFILE = 'rating-question-presentation-v2';
export const QUESTION_PRESENTATION_STORAGE_PROFILE_IRI = `https://rezics.com/definition/${QUESTION_PRESENTATION_STORAGE_PROFILE}`;
export const QUESTION_PRESENTATION_KINDS =
  'rv:RatingQuestionPresentation rv:RatingQuestionPresentationV2';
export const QUESTION_PRESENTATION_REVISION_PROFILES = `VALUES (?presentationRevisionKind ?presentationProfile) {
  (rv:RatingQuestionPresentationRevision <${QUESTION_PRESENTATION_PROFILE_IRI}>)
  (rv:RatingQuestionPresentationV2Revision <${QUESTION_PRESENTATION_STORAGE_PROFILE_IRI}>) }`;
export const QUESTION_PRESENTATION_FAMILY = 'rating-question-presentation-change';
export const QUESTION_PRESENTATION_ACTIONS = ratingQuestionPresentationActions;
/** Writes touch two focuses and one language row. Reads inspect O(L) index rows
 * for each of at most 20 Contexts, resolve only selected objects, and share the
 * Work read's byte/call/deadline budget. At most 64 readable, current reviewed languages per Context. */
export const QUESTION_PRESENTATION_COST = {
  reviewedLanguagesPerContext: 64,
  reviewedIndexRows: 65,
  requestBytes: 8192,
  languagesPerRequest: 20,
  contextBatch: 20,
  validationFocuses: 2,
  writeGraphCalls: 32,
  writeGraphBytes: 256 * 1024,
  commandBytes: 32_768,
  selectedObjectsPerContext: 1,
  lookupRows: 2,
  lookupGraphCalls: 16,
  lookupGraphBytes: 256 * 1024,
  lookupDeadlineMs: 10_000,
} as const;
export interface QuestionPresentationState {
  context: string;
  language: string;
  question: string;
  source: string;
  licence: string;
  reviewStatus: 'draft' | 'reviewed';
}
export const questionPresentationStateSchema = t.Object(
  {
    context: readId,
    language: languageTagSchema(255),
    question: t.String({ minLength: 3, maxLength: 120 }),
    source: t.String({ maxLength: 2048 }),
    licence: t.String({ maxLength: 2048 }),
    reviewStatus: t.Union([t.Literal('draft'), t.Literal('reviewed')]),
  },
  { additionalProperties: false },
);
export const questionDisplaySchema = t.Object({
  value: t.String(),
  language: t.String(),
  direction: t.Union([t.Literal('ltr'), t.Literal('rtl')]),
  basis: displayLanguageBasis,
  script: t.Nullable(t.String()),
  reviewStatus: t.Union([t.Literal('authored'), t.Literal('draft'), t.Literal('reviewed')]),
  presentation: t.Nullable(t.Object({ component: readId, revision: readId })),
  source: t.Nullable(t.String()),
  licence: t.Nullable(t.String()),
  fallback: t.Nullable(
    t.Object({
      reason: t.Union([t.Literal('language-fallback'), t.Literal('script-fallback')]),
      requestedLanguages: t.Array(t.String()),
      usedLanguage: t.String(),
      requestedScript: t.Nullable(t.String()),
      usedScript: t.Nullable(t.String()),
      crossedScript: t.Boolean(),
      conversion: t.Null(),
    }),
  ),
});
export const questionReadFields = {
  language: languageTagSchema(255),
  displayQuestion: questionDisplaySchema,
};
export const questionLanguagesQuery = { languages: t.Optional(t.String({ maxLength: 8192 })) };

export function questionPresentationAction(state: Pick<QuestionPresentationState, 'reviewStatus'>) {
  // Keeping reviewed status while changing wording is another review decision.
  return state.reviewStatus === 'reviewed'
    ? QUESTION_PRESENTATION_ACTIONS[1]
    : QUESTION_PRESENTATION_ACTIONS[0];
}
export const questionPresentationScope = (context: string) => `rating:presentation:${context}`;
const invalid = (): never => {
  throw new SemanticChangeRejected('invalid', 'Rating question presentation is invalid');
};
export function checkedQuestionPresentation(input: unknown): QuestionPresentationState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const row = input as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        !['context', 'language', 'question', 'source', 'licence', 'reviewStatus'].includes(key),
    )
  )
    return invalid();
  const language =
    typeof row.language === 'string' && row.language.length <= 255
      ? canonicalLanguage(row.language)
      : null;
  if (!language || typeof row.context !== 'string') return invalid();
  try {
    checkedNativeIri(row.context);
  } catch {
    return invalid();
  }
  const text = (value: unknown, min: number, max: number) => {
    if (
      typeof value !== 'string' ||
      value.length < min ||
      value.length > max ||
      !value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      return invalid();
    return value;
  };
  const uri = (value: unknown) => {
    const result = text(value, 1, 2048);
    if (!/^https?:\/\/[^\s<>"{}|\\^`]+$/u.test(result)) return invalid();
    return result;
  };
  if (row.reviewStatus !== 'draft' && row.reviewStatus !== 'reviewed') return invalid();
  const state: QuestionPresentationState = {
    context: row.context,
    language,
    question: text(row.question, 3, 120),
    source: uri(row.source),
    licence: uri(row.licence),
    reviewStatus: row.reviewStatus,
  };
  if (Buffer.byteLength(JSON.stringify(state)) > QUESTION_PRESENTATION_COST.requestBytes)
    return invalid();
  return state;
}
/** Retiring withdraws a presentation's public review so its language no longer
 * counts toward the cap. It is a draft of an existing presentation, which needs
 * only the configuring authority a draft does. */
export function checkedRetirement(
  retire: boolean | undefined,
  target: string | undefined,
  state: QuestionPresentationState,
) {
  if (retire && (target === undefined || state.reviewStatus !== 'draft')) return invalid();
  return retire === true;
}
export function questionPresentationDigest(
  target: string | undefined,
  expectedHead: string | null,
  state: QuestionPresentationState,
  retire?: boolean,
) {
  if (target !== undefined) checkedNativeIri(target);
  if (expectedHead !== null) checkedNativeIri(expectedHead);
  if ((target === undefined) !== (expectedHead === null)) return invalid();
  return hash(
    JSON.stringify({
      family: QUESTION_PRESENTATION_FAMILY,
      target: target ?? null,
      expectedHead,
      state: checkedQuestionPresentation(state),
      // Absent unless set, so every earlier admission keeps its digest.
      ...(checkedRetirement(retire, target, state) ? { retire: true } : {}),
    }),
  );
}
