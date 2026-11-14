import type { ZonePageResponse } from '../../zones/appearance';
import {
  mangaCandidateDocument,
  mangaCandidateIds,
  mangaCandidateShell,
  mangaCandidateSubjects,
} from '../../zones/candidates/manga';
import type { FakeRoute } from '../fake-modules';

type CandidateState = 'preview' | 'empty' | 'sparse' | 'closed' | 'unavailable' | 'concealed';

const stateByZone = new Map<string, CandidateState>(
  Object.entries(mangaCandidateIds).map(([state, id]) => [id, state as CandidateState]),
);

function readPageResponse(zoneId: string, route: string, state: CandidateState): ZonePageResponse | undefined {
  const document = mangaCandidateDocument(route);
  if (!document) return undefined;

  const subjects =
    state === 'preview' ? mangaCandidateSubjects : state === 'sparse' ? mangaCandidateSubjects.slice(0, 1) : [];

  return {
    profile: 'manga-candidate-preview',
    template: { scope: 'route', key: route },
    document,
    reads:
      route === ''
        ? {
            works: {
              status: 'ready',
              items: subjects.map((subject) => ({
                id: subject.id,
                subject: subject.id,
                label: { en: subject.label },
                types: ['schema:ComicSeries'],
              })),
              next: null,
            },
          }
        : {},
    zone: mangaCandidateShell(zoneId),
  };
}

function errorRecording(status: number, code: string, message: string, headers?: Record<string, string>) {
  return {
    status,
    ...(headers ? { headers } : {}),
    body: { error: { code, message } },
  };
}

async function answerCandidate(request: Request, zoneId: string) {
  const state = stateByZone.get(zoneId);
  if (!state) return undefined;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorRecording(404, 'not_found', 'Page not found.');
  }
  if (typeof body !== 'object' || body === null || !('target' in body))
    return errorRecording(404, 'not_found', 'Page not found.');

  const target = (body as { target?: unknown }).target;
  if (typeof target !== 'object' || target === null) return errorRecording(404, 'not_found', 'Page not found.');

  if ('route' in target) {
    const route = (target as { route?: unknown }).route;
    if (route !== '' && route !== 'volumes') return errorRecording(404, 'not_found', 'Page not found.');
    if (state === 'concealed') return errorRecording(404, 'not_found', 'Page not found.');
    if (route === '' && state === 'closed')
      return errorRecording(403, 'platform_closed', 'platform_closed — Manga source access is closed.');
    if (route === '' && state === 'unavailable')
      return errorRecording(503, 'semantic_not_ready', 'semantic_not_ready — Manga source preparation is not ready.', {
        'Retry-After': '1',
      });

    const response = readPageResponse(zoneId, route, state);
    return response ? { status: 200, body: response } : undefined;
  }

  if ('subject' in target) {
    const subjectId = (target as { subject?: unknown }).subject;
    const subject = mangaCandidateSubjects.find((candidate) => candidate.id === subjectId);
    if (!subject || (state !== 'preview' && state !== 'sparse'))
      return errorRecording(404, 'not_found', 'Page not found.');

    return {
      status: 200,
      body: {
        profile: 'manga-candidate-preview',
        template: { scope: 'generic', key: null },
        document: {
          root: { props: {} },
          content: [
            {
              type: 'Stack',
              props: {
                id: 'manga-subject-preview',
                gap: 'md',
                children: [
                  {
                    type: 'Heading',
                    props: { id: 'title', text: subject.label, level: 2 },
                  },
                  {
                    type: 'Text',
                    props: {
                      id: 'preview-note',
                      text: 'Fictional subject in a gated development preview; no public source release is claimed.',
                    },
                  },
                ],
              },
            },
          ],
        },
        reads: {},
        zone: mangaCandidateShell(zoneId),
        subject: subject.id,
        views: [],
      } satisfies ZonePageResponse,
    };
  }

  return undefined;
}

export const routes = Object.entries(mangaCandidateIds).map(([, id]) => ({
  method: 'POST',
  path: `/zones/${id}:readPage`,
  story: ({ request }: { request: Request }) => answerCandidate(request, id),
})) satisfies FakeRoute[];
