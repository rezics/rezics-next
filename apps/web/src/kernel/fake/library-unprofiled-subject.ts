import type { FakeRoute } from '../fake-modules';

/** A contract-shaped failure fixture: the activated release has no library profile for schema:Person. */
export const unprofiledSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000803';
const unprofiledType = 'schema:Person';
const labels: Record<string, string> = {
  en: 'Person',
  'zh-Hant': '人物',
  'zh-Hans': '人物',
  ja: '人物',
  ko: '사람',
  de: 'Person',
  fr: 'Personne',
  es: 'Persona',
};

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/progressSessions',
    story: ({ request }) => {
      if (new URL(request.url).searchParams.get('subjectId') !== unprofiledSubjectId) return;
      return { status: 200, progressSessions: [], next: null };
    },
  },
  {
    method: 'GET',
    path: '/v1/copies',
    story: ({ request }) => {
      if (new URL(request.url).searchParams.get('subjectId') !== unprofiledSubjectId) return;
      return { status: 200, copies: [], next: null };
    },
  },
  {
    method: 'GET',
    path: `/v1/subjects/${unprofiledSubjectId}`,
    story: ({ request }) => {
      const locale = request.headers.get('accept-language')?.split(',')[0]?.trim() ?? 'en';
      return {
        status: 200,
        subject: { id: unprofiledSubjectId, type: unprofiledType },
        summary: {
          id: unprofiledSubjectId,
          type: unprofiledType,
          types: [unprofiledType],
          label: { value: labels[locale] ?? labels.en!, language: labels[locale] ? locale : 'en' },
          cover: null,
        },
      };
    },
  },
];
