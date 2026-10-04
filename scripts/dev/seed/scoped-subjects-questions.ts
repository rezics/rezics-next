import { GLOBAL_RATING_POPULATION_OWNER } from '../../../services/main/src/modules/rating/global.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { QuestionPresentationState } from '../../../services/main/src/modules/rating/question-presentation-schema.ts';

export const scopedSubjectLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
type Labels = Record<(typeof scopedSubjectLocales)[number], string>;
const RV = 'https://rezics.com/vocab/';
export const scopedSubjectQuestions = [
  {
    key: 'character', targetGrain: 'resource', acceptedSubjectTypes: [`${RV}Character`],
    labels: {
      en: 'How much do you like this character?',
      'zh-Hant': '你有多喜歡這個角色？', 'zh-Hans': '你有多喜欢这个角色？',
      ja: 'このキャラクターはどれくらい好きですか？', ko: '이 캐릭터를 얼마나 좋아하나요?',
      de: 'Wie sehr magst du diese Figur?', fr: 'À quel point aimez-vous ce personnage ?',
      es: '¿Cuánto te gusta este personaje?',
    } satisfies Labels,
  },
  {
    key: 'performance', targetGrain: 'projection', acceptedSubjectTypes: [`${RV}Character`, 'https://schema.org/Person'],
    acceptedFrameDimensions: ['position', 'event'],
    labels: {
      en: 'How did they do here?',
      'zh-Hant': '這個角色或人物在這裡表現如何？', 'zh-Hans': '这个角色或人物在这里表现如何？',
      ja: 'ここでの活躍はどうでしたか？', ko: '여기서 얼마나 잘했나요?',
      de: 'Wie war die Leistung hier?', fr: 'Quelle a été sa performance ici ?',
      es: '¿Qué tal lo hizo aquí?',
    } satisfies Labels,
  },
  {
    key: 'unit', targetGrain: 'projection', acceptedSubjectTypes: [`${RV}GameUnit`],
    acceptedFrameDimensions: ['release'],
    labels: {
      en: 'How strong is this unit in this version?',
      'zh-Hant': '這個單位在此版本中有多強？', 'zh-Hans': '这个单位在此版本中有多强？',
      ja: 'このバージョンでこのユニットはどれくらい強いですか？', ko: '이 버전에서 이 유닛은 얼마나 강한가요?',
      de: 'Wie stark ist diese Einheit in dieser Version?',
      fr: 'Quelle est la puissance de cette unité dans cette version ?',
      es: '¿Qué tan fuerte es esta unidad en esta versión?',
    } satisfies Labels,
  },
] as const;

export interface ScopedSubjectApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: object, key: string): Promise<T>;
  put<T>(path: string, body: object, key: string): Promise<T>;
}
export interface GlobalQuestion {
  context: string;
  contextRevision: string;
  displayThreshold: number;
  presentations: Record<string, { component: string; revision: string }>;
}
export type GlobalQuestions = Record<(typeof scopedSubjectQuestions)[number]['key'], GlobalQuestion>;

interface CurrentPresentation { component: string; revision: string; state: QuestionPresentationState }
function problemCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('detail' in error && typeof error.detail === 'string') {
    try { return (JSON.parse(error.detail) as { code?: string }).code ?? null; }
    catch { return null; }
  }
  return null;
}

/** Read the exact language slot before writing. A confirmed cancellation has
 * no later graph effect, so only that terminal outcome permits a new attempt
 * key over the same CAS head. Pending/lost responses keep their original key. */
export async function ensureReviewedQuestionPresentation(api: Pick<ScopedSubjectApi, 'get' | 'post'>,
  actor: string, namespace: string, context: string, contextRevision: string,
  language: string, question: string): Promise<{ component: string; revision: string }> {
  const cancelled = new Set<string>();
  const desired: QuestionPresentationState = { context, language, question,
    source: 'https://rezics.com/definition/scoped-subject-questions-v1',
    licence: 'https://creativecommons.org/publicdomain/zero/1.0/', reviewStatus: 'reviewed' };
  const path = `/v1/rating-question-presentations?${new URLSearchParams({ context, language, actingSubject: actor })}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const { presentation: current } = await api.get<{ presentation: CurrentPresentation | null }>(path);
    if (current && (current.state.context !== context || current.state.language !== language))
      throw new Error('Question presentation lookup returned another language slot');
    if (current?.state.reviewStatus === 'reviewed') return { component: current.component, revision: current.revision };
    const basis = createHash('sha256').update(JSON.stringify([namespace, actor, contextRevision,
      current?.component ?? null, current?.revision ?? null, desired])).digest('hex');
    const key = `question-review:v2:${cancelled.has(basis)
      ? createHash('sha256').update(`${basis}:${randomUUID()}`).digest('hex') : basis}`;
    try {
      const written = await api.post<{ component: string; revision: string }>('/v1/rating-question-presentations', {
        profile: 'rating-question-presentation-v1', actingSubject: actor,
        ...(current ? { target: current.component } : {}), expectedHead: current?.revision ?? null, state: desired,
      }, key);
      return { component: written.component, revision: written.revision };
    } catch (error) {
      const code = problemCode(error);
      if (code === 'operation_cancelled') { cancelled.add(basis); continue; }
      if (code === 'stale_head') continue;
      throw error;
    }
  }
  throw new Error('Question presentation did not converge; rerun to read its current head');
}

/** Three English-authored measurements, each with seven independently reviewed
 * presentations. Only wording varies by locale; all ratings keep one Context.
 * A settled rerun writes no presentation. Each attempt has one bounded slot
 * lookup and one CAS; unrelated questions and ratings are never enumerated. */
export async function seedScopedSubjectQuestions(api: Pick<ScopedSubjectApi, 'get' | 'post'>, actingSubject: string,
  namespace: string): Promise<GlobalQuestions> {
  const questions = {} as GlobalQuestions;
  for (const spec of scopedSubjectQuestions) {
    const key = `${namespace}:global-question:v1:${spec.key}`;
    const created = await api.post<Omit<GlobalQuestion, 'presentations'>>('/v1/rating-contexts', {
      profile: 'realm-target-rating-context-v4', realm: GLOBAL_RATING_POPULATION_OWNER,
      question: spec.labels.en, language: 'en', targetGrain: spec.targetGrain,
      acceptedSubjectTypes: [...spec.acceptedSubjectTypes],
      ...('acceptedFrameDimensions' in spec ? { acceptedFrameDimensions: [...spec.acceptedFrameDimensions] } : {}),
      actingSubject,
    }, key);
    const presentations: GlobalQuestion['presentations'] = {};
    for (const language of scopedSubjectLocales.filter(locale => locale !== 'en')) {
      presentations[language] = await ensureReviewedQuestionPresentation(api, actingSubject, namespace,
        created.context, created.contextRevision, language, spec.labels[language]);
    }
    questions[spec.key] = { ...created, presentations };
  }
  return questions;
}
