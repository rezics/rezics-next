import { GLOBAL_RATING_POPULATION_OWNER } from '../../../services/main/src/modules/rating/global.ts';

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

/** Three English-authored measurements, each with seven independently reviewed
 * presentations. Only wording varies by locale; all ratings keep one Context.
 * Cost: 24 sequential API writes, independent of catalogue or rater size. */
export async function seedScopedSubjectQuestions(api: Pick<ScopedSubjectApi, 'post'>, actingSubject: string,
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
      presentations[language] = await api.post('/v1/rating-question-presentations', {
        profile: 'rating-question-presentation-v1', expectedHead: null, actingSubject,
        state: { context: created.context, language, question: spec.labels[language],
          source: 'https://rezics.com/definition/scoped-subject-questions-v1',
          licence: 'https://creativecommons.org/publicdomain/zero/1.0/', reviewStatus: 'reviewed' },
      }, `${key}:${language}`);
    }
    questions[spec.key] = { ...created, presentations };
  }
  return questions;
}
