import type { FakeRoute } from '../fake-modules.ts';
import type { KernelRecording } from '../fake.ts';
import active from '../recorded/definitions-active.json';
import { storyViewerId } from './identities.ts';

const scenarios = {
  everything: { kind: 'everything' },
  liked: { kind: 'liked' },
  state: { kind: 'state', labels: { en: 'Reading', ja: '読書', 'zh-Hans': '在读', 'zh-Hant': '在讀' } },
  empty: { kind: 'everything', empty: true },
  renamed: { kind: 'everything', title: 'My reading shelf' },
  'state-other': { kind: 'state', labels: {} },
  paged: { kind: 'everything', next: 'dynamic-next-page' },
  preparing: { kind: 'everything', preparing: true },
  unavailable: { kind: 'everything', unavailable: true },
  saved: { title: 'Saved query', visibility: 'public' },
  'saved-empty': { title: 'Saved query', empty: true, visibility: 'public' },
  'saved-preparing': { title: 'Saved query', preparing: true, visibility: 'public' },
  'saved-unavailable': { title: 'Saved query', unavailable: true, visibility: 'public' },
  'saved-stale': { title: 'Saved query', stale: true, visibility: 'public' },
  'saved-private': { title: 'Private saved query', visibility: 'private', conceal: true },
} as const;
const ids = new Map(Object.keys(scenarios).map((key) => [`dynamic-${key}`, key as keyof typeof scenarios]));

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/collections\/(dynamic-[a-z-]+)(?:\/members|\/rule)?$/,
    story: ({ request, match }): KernelRecording | undefined => {
      const id = match?.[1];
      const scenarioName = id ? ids.get(id) : undefined;
      if (!id || !scenarioName) return;
      const scenario = scenarios[scenarioName];
      if ('conceal' in scenario && scenario.conceal && !request.headers.has('authorization'))
        return { status: 404, code: 'not_found' };
      if (new URL(request.url).pathname.endsWith('/rule')) {
        if ('kind' in scenario) return;
        if (!request.headers.has('authorization')) return { status: 404, code: 'not_found' };
        return {
          status: 200,
          rule: {
            filter: { type: { in: ['schema:Book'] } },
            sort: 'id',
            revision: 1,
            collectionRevision: 1,
            sourceGeneration: '1',
            releaseDigest: active.digest,
          },
        };
      }
      if (new URL(request.url).pathname.endsWith('/members')) {
        if ('preparing' in scenario && scenario.preparing) return { status: 202, preparing: true };
        if ('unavailable' in scenario && scenario.unavailable) return { status: 503, code: 'unavailable' };
        if ('stale' in scenario && scenario.stale && new URL(request.url).searchParams.get('cursor'))
          return { status: 409, code: 'stale_cursor' };
        const members =
          'empty' in scenario && scenario.empty
            ? []
            : [
                {
                  kind: 'dynamic',
                  subjectId: 'dynamic-subject',
                  subject: {
                    id: 'dynamic-subject',
                    type: 'book',
                    label: { value: 'The Long Way to a Small, Quiet Library', language: 'en' },
                  },
                },
              ];
        return { status: 200, members, next: 'next' in scenario ? scenario.next : null };
      }
      return {
        status: 200,
        collection: {
          id,
          curatorAccountId: 'kind' in scenario ? 'story-owner' : storyViewerId,
          title: 'title' in scenario ? scenario.title : null,
          description: null,
          visibility: 'visibility' in scenario ? scenario.visibility : 'private',
          revision: 1,
          membershipKind: 'dynamic',
          ...('kind' in scenario ? { builtinKind: scenario.kind } : {}),
          ...('labels' in scenario ? { builtinLabels: scenario.labels } : {}),
        },
      };
    },
  },
];
