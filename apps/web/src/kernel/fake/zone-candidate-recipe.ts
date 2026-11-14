import type { FakeRoute } from '../fake-modules';
import {
  RECIPE_HOME_COPY,
  RECIPE_ZONE_IDS,
  recipeHomeResponse,
  recipeSubject,
  recipeSubjectResponse,
  recipeZone,
  type RecipeCandidateState,
} from '../../zones/candidates/recipe';

type StoryRecording = Exclude<
  Awaited<ReturnType<NonNullable<FakeRoute['story']>>>,
  undefined | void
>;

const zoneIds = Object.values(RECIPE_ZONE_IDS);
const zonePath = new RegExp(`^/v1/zones/(${zoneIds.join('|')}):readPage$`);
const subjectPrefix = '0193c100-0006-7000-8000-';
const notFound = {
  error: { code: 'not_found', message: 'This page is not available.' },
};

type ReadPageInput = {
  target?: { route?: unknown; subject?: unknown; view?: unknown };
};

function isReadPageInput(value: unknown): value is ReadPageInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'target' in value &&
    typeof value.target === 'object'
  );
}

function routeState(zoneId: string): RecipeCandidateState | undefined {
  return (
    Object.entries(RECIPE_ZONE_IDS) as [RecipeCandidateState, string][]
  ).find(([, id]) => id === zoneId)?.[0];
}

async function inputFor(request: Request): Promise<ReadPageInput | undefined> {
  try {
    const value: unknown = await request.json();
    return isReadPageInput(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function reply(
  request: Request,
  path: string,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): StoryRecording {
  const responseHeaders = { 'content-type': 'application/json', ...headers };
  return {
    request: { method: request.method, path },
    response: { status, headers: responseHeaders, body },
  } as unknown as StoryRecording;
}

function sourceStateFailure(
  state: RecipeCandidateState,
  request: Request,
  path: string,
): StoryRecording | undefined {
  if (state === 'private' || state === 'missing')
    return reply(request, path, 404, notFound);
  if (state === 'closed') {
    return reply(request, path, 403, {
      error: {
        code: 'platform_closed',
        message:
          'platform_closed: this development preview has no source admission.',
      },
    });
  }
  if (state === 'unavailable') {
    return reply(
      request,
      path,
      503,
      {
        error: {
          code: 'semantic_not_ready',
          message:
            'semantic_not_ready: recipe sources are not ready. Retry this page.',
        },
      },
      { 'retry-after': '1' },
    );
  }
  return undefined;
}

async function readPage(
  request: Request,
  path: string,
  zoneId: string,
): Promise<StoryRecording | undefined> {
  const state = routeState(zoneId);
  if (!state) return undefined;
  const input = await inputFor(request);
  if (!input?.target) return undefined;

  const failure = sourceStateFailure(state, request, path);
  if (failure) return failure;

  if (typeof input.target.route === 'string') {
    if (input.target.route !== '') return undefined;
    if (state !== 'admitted' && state !== 'empty' && state !== 'sparse')
      return undefined;
    return reply(request, path, 200, recipeHomeResponse(state));
  }

  if (typeof input.target.subject !== 'string') return undefined;
  if (!input.target.subject.startsWith(subjectPrefix)) return undefined;
  if (input.target.view !== undefined && input.target.view !== 'overview') {
    return reply(request, path, 404, notFound);
  }
  if (state !== 'admitted' && state !== 'empty' && state !== 'sparse') {
    return reply(request, path, 404, notFound);
  }

  const candidate = recipeSubject(input.target.subject, state);
  if (
    !candidate ||
    !RECIPE_HOME_COPY[state].some(({ id }) => id === candidate.id)
  ) {
    return reply(request, path, 404, notFound);
  }
  const zone = recipeZone(state);
  return reply(request, path, 200, recipeSubjectResponse(candidate, zone));
}

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: zonePath,
    story: async ({ request, match }) => {
      const zoneId = match?.[1];
      if (!zoneId || !zoneIds.includes(zoneId)) return undefined;
      return readPage(request, new URL(request.url).pathname, zoneId);
    },
  },
];
