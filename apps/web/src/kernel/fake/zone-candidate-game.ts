import type { KernelRecording } from '../fake';
import type { FakeRoute } from '../fake-modules';
import {
  videoGameCandidate,
  videoGameSubjectResponse,
  videoGameZoneIds,
  videoGameZonePageResponse,
  videoGameZoneSubjectResponse,
  type VideoGameReadState,
} from '../../zones/candidates/game';

type StoryState = VideoGameReadState | 'platform-closed' | 'semantic-not-ready' | 'concealed-private' | 'missing';

const zoneStates: [string, StoryState][] = [
  [videoGameZoneIds.admittedPreview, 'admitted-preview'],
  [videoGameZoneIds.platformClosed, 'platform-closed'],
  [videoGameZoneIds.semanticNotReady, 'semantic-not-ready'],
  [videoGameZoneIds.readyEmpty, 'ready-empty'],
  [videoGameZoneIds.sparse, 'sparse'],
  [videoGameZoneIds.concealedPrivate, 'concealed-private'],
  [videoGameZoneIds.missing, 'missing'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function routeTarget(value: unknown): { route: string } | { subject: string } | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
  if (typeof value.route === 'string') return { route: value.route };
  if (typeof value.subject === 'string') return { subject: value.subject };
  return undefined;
}

function storyZoneRoute(zoneId: string, state: StoryState): FakeRoute {
  return {
    method: 'POST',
    path: `/v1/zones/${zoneId}:readPage`,
    story: async ({ request }) => {
      const body = await readJson(request);
      const target = isRecord(body) ? routeTarget(body.target) : undefined;
      if (!target) return undefined;
      if (state === 'concealed-private' || state === 'missing') return { status: 404, code: 'not_found' };
      if (state === 'platform-closed') return { status: 403, code: 'platform_closed' };
      if (state === 'semantic-not-ready')
        return { status: 503, code: 'semantic_not_ready', headers: { 'Retry-After': '1' } };
      if ('route' in target) {
        if (!videoGameCandidate.routes.includes(target.route)) return { status: 404, code: 'not_found' };
        const page = videoGameZonePageResponse(zoneId, target.route, state);
        return page ? ({ status: 200, ...page } satisfies KernelRecording) : undefined;
      }
      const page = videoGameZoneSubjectResponse(zoneId, target.subject);
      return page ? ({ status: 200, ...page } satisfies KernelRecording) : { status: 404, code: 'not_found' };
    },
  };
}

export const routes: FakeRoute[] = [
  ...zoneStates.map(([id, state]) => storyZoneRoute(id, state)),
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: async ({ request }) => {
      const body = await readJson(request);
      const target = isRecord(body) ? body.target : undefined;
      if (
        !isRecord(target) ||
        typeof target.subject !== 'string' ||
        Object.keys(target).some((key) => key !== 'subject' && key !== 'view') ||
        (target.view !== undefined && target.view !== 'overview')
      )
        return undefined;
      const page = videoGameSubjectResponse(target.subject);
      return page ? ({ status: 200, ...page } satisfies KernelRecording) : undefined;
    },
  },
];
