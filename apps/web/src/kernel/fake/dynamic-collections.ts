import type { FakeRoute } from '../fake-modules.ts';
import type { KernelRecording } from '../fake.ts';

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
} as const;
const ids = new Map(Object.keys(scenarios).map((key) => [`dynamic-${key}`, key as keyof typeof scenarios]));

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/collections\/(dynamic-[a-z-]+)(?:\/members)?$/,
    story: ({ request, match }): KernelRecording | undefined => {
      const id = match?.[1];
      const scenarioName = id ? ids.get(id) : undefined;
      if (!id || !scenarioName) return;
      const scenario = scenarios[scenarioName];
      if (new URL(request.url).pathname.endsWith('/members')) {
        if ('preparing' in scenario && scenario.preparing) return { status: 202, preparing: true };
        if ('unavailable' in scenario && scenario.unavailable) return { status: 503, code: 'unavailable' };
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
          curatorAccountId: 'story-owner',
          title: 'title' in scenario ? scenario.title : null,
          description: null,
          visibility: 'private',
          revision: 1,
          membershipKind: 'dynamic',
          builtinKind: scenario.kind,
          ...('labels' in scenario ? { builtinLabels: scenario.labels } : {}),
        },
      };
    },
  },
];
