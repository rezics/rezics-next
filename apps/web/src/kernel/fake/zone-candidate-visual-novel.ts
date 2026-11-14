import type { KernelRecording } from '../fake';
import type { FakeRoute } from '../fake-modules';
import { visualNovelPageResponse, visualNovelReadCases } from '../../zones/candidates/visual-novel';

type RouteRequest = { target?: { route?: unknown } };

function recording(status: number, body: unknown, headers: Record<string, string> = {}): KernelRecording {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body,
  } as unknown as KernelRecording;
}

function routeName(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const route = (body as RouteRequest).target?.route;
  if (typeof route !== 'string') return undefined;
  return route.replace(/^\/+|\/+$/g, '');
}

async function answer(zoneId: string, request: Request): Promise<KernelRecording | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  const route = routeName(body);
  if (route === undefined) return undefined;

  const state = visualNovelReadCases[zoneId]?.[route];
  if (state && state.status !== 200) {
    return recording(state.status, { error: state.error }, state.headers);
  }

  const response = visualNovelPageResponse(zoneId, route);
  if (response) return recording(200, response);
  return recording(404, { error: 'not_found' });
}

/** Exact candidate IDs precede the broad Zone fake and leave every other Zone to its owner. */
export const routes: FakeRoute[] = Object.keys(visualNovelReadCases).map((zoneId) => ({
  method: 'POST',
  path: `/api/zones/${zoneId}:readPage`,
  story: ({ request }) => answer(zoneId, request),
  fixture: ({ request }) => answer(zoneId, request),
}));
