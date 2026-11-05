import type { FakeRoute } from '../fake-modules';
import type { LibraryProfile } from '@rezics/definitions';

export const profileSessionId = '0192f3a0-6c1e-7b2a-9d4e-000000000801';
export const retiredSessionId = '0192f3a0-6c1e-7b2a-9d4e-000000000802';
export const progressProfile: LibraryProfile = {
  id: 'route-progress',
  importSources: [],
  progress: {
    allowed: [
      {
        mode: 'scalar_amount',
        units: [
          {
            id: 'segment-x',
            labels: { en: 'segments', ja: '区間', de: 'Abschnitte' },
            minimum: '0.25',
            maximum: '98.5',
            precision: 2,
            totalPolicy: 'required',
            identity: { kind: 'none' },
            structure: { kind: 'none' },
          },
        ],
      },
    ],
  },
};
export const profileSession = {
  id: profileSessionId,
  subjectId: profileSessionId,
  versionSubjectId: null,
  mode: 'scalar_amount',
  unit: 'segment-x',
  amount: '2.5',
  total: '10',
  locator: null,
  position: null,
  completedUnitCount: 0,
  state: 'active',
  revision: 1,
  startedAt: '2026-10-29T00:00:00.000Z',
  completedAt: null,
  subject: {
    id: profileSessionId,
    type: 'route:Journey',
    types: ['route:Journey'],
    label: 'A journey through the mountains',
    cover: null,
  },
  versionSubject: null,
};
export const unsupportedProgress = {
  status: 422,
  code: 'unsupported_library_profile',
  effect_status: 'not_applied',
  retryable: false,
};
// fake-modules.ts discovers and registers this module in both Vite and Bun.
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/definitions\/releases\//,
    story: ({ recordings }) => {
      const recorded = recordings['definitions-release'];
      const release = recorded?.release as { types: object; libraryProfiles: object } | undefined;
      if (!release) return;
      return {
        ...recorded,
        status: 200,
        release: {
          ...release,
          types: {
            ...release.types,
            'route:Journey': {
              labels: { en: 'Journey', ja: '旅', de: 'Reise' },
              library: { profileId: progressProfile.id },
            },
          },
          libraryProfiles: { ...release.libraryProfiles, [progressProfile.id]: progressProfile },
        },
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/[^/]+$/,
    story: ({ match }) => {
      const id = match?.[0].split('/').at(-1);
      if (id !== profileSessionId && id !== retiredSessionId) return;
      return {
        status: 200,
        progressSession: { ...profileSession, id, ...(id === retiredSessionId ? { unit: 'retired-segment' } : {}) },
      };
    },
  },
  ...['changes', 'completedUnits'].map((part) => ({
    method: 'GET',
    path: new RegExp(`^/v1/progressSessions/(?:${profileSessionId}|${retiredSessionId})/${part}$`),
    story: () => ({ status: 200, [part]: [], next: null }),
  })),
  { method: 'POST', path: `/v1/progressSessions/${profileSessionId}:record`, story: () => unsupportedProgress },
];
