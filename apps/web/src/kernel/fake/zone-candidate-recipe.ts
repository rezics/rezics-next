import {
  PAGE_GLOBAL_CONTEXT,
  definedViews,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type PresentationProfile,
  type SelectedContext,
  type View,
} from '@rezics/composition';
import profileJson from '@rezics/composition/profiles/platform.json';
import definitions from '../recorded/definitions-release.json';
import type { KernelRecording } from '../fake';
import type { FakeRoute } from '../fake-modules';
import {
  RECIPE_HOME_COPY,
  RECIPE_ZONE_IDS,
  recipeCandidate,
  recipeHomeResponse,
  recipeSubjectRead,
  recipeZone,
  type RecipeCandidateState,
} from '../../zones/candidates/recipe';

const profile = profileJson as PresentationProfile;
const typeDefinitions = definitions.release.types as Record<string, { bases: string[] }>;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function problem(
  status: number,
  code: string,
  title: string,
  headers: Record<string, string> = { 'cache-control': 'no-store' },
): KernelRecording {
  return {
    status,
    headers,
    type: `https://rezics.com/problems/${code}`,
    title,
    code,
    retryable: status === 503,
    effect_status: 'not_applicable',
    request_id: 'recipe-candidate-preview',
  };
}

const notFound = () => problem(404, 'not_found', 'Not Found');
const sourceClosed = () => problem(403, 'platform_closed', 'Platform Closed');
const semanticUnavailable = () =>
  problem(503, 'semantic_not_ready', 'Service Unavailable', {
    'cache-control': 'no-store',
    'retry-after': '1',
  });

function stateForZone(id: string | undefined): RecipeCandidateState | undefined {
  if (!id) return undefined;
  return (Object.keys(RECIPE_ZONE_IDS) as RecipeCandidateState[]).find((state) => RECIPE_ZONE_IDS[state] === id);
}

function isListed(state: RecipeCandidateState, id: string): boolean {
  return state === 'admitted' || state === 'sparse'
    ? RECIPE_HOME_COPY[state].some((candidate) => candidate.id === id)
    : false;
}

function requestedLanguages(input: RecordValue | undefined, request: Request): string[] {
  const supplied = Array.isArray(input?.languages)
    ? input.languages.filter((language): language is string => typeof language === 'string')
    : [];
  const accepted = (request.headers.get('accept-language') ?? '')
    .split(',')
    .map((language) => language.split(';')[0]?.trim())
    .filter((language): language is string => Boolean(language));
  return [...supplied, ...accepted, 'en'];
}

function pageForSubject(
  subjectId: string,
  requestedView: unknown,
  languages: readonly string[],
): (RecordValue & { views: string[] }) | undefined {
  const candidate = recipeCandidate(subjectId);
  if (!candidate) return undefined;
  const bases = typeDefinitions[candidate.type]?.bases;
  if (!bases) return undefined;
  const target = { type: candidate.type, bases };
  const views = definedViews(profile, target);
  const view = requestedView ?? 'overview';
  if (typeof view !== 'string') return undefined;
  const selectedView = view as View;
  if (!views.includes(selectedView)) return undefined;
  const resolved = resolveView(profile, target, selectedView);
  if (!resolved) return undefined;

  const context: SelectedContext = {
    id: PAGE_GLOBAL_CONTEXT,
    population: { kind: 'global' },
  };
  const plan = planReads(platformRegistry, resolved.document, {
    subject: subjectId,
    context,
  });
  const reads = Object.fromEntries(
    Object.entries(plan.reads).map(([key, read]) => [
      key,
      read.kind === 'subject'
        ? { status: 200, body: recipeSubjectRead(candidate, languages) }
        : { status: 204, body: null },
    ]),
  );

  return {
    subject: subjectId,
    context,
    profile: profileDigest(profile),
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    views,
    reads,
  };
}

async function readInput(request: Request): Promise<RecordValue | undefined> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

const zoneRead: NonNullable<FakeRoute['story']> = async ({ request, match }) => {
  const state = stateForZone(match?.[1] ? decodeURIComponent(match[1]) : undefined);
  if (!state) return undefined;
  if (state === 'closed') return sourceClosed();
  if (state === 'unavailable') return semanticUnavailable();
  if (state === 'private' || state === 'missing') return notFound();

  const input = await readInput(request);
  const target = input?.target;
  if (!isRecord(target)) return notFound();
  const languages = requestedLanguages(input, request);

  if (typeof target.subject === 'string') {
    if (!isListed(state, target.subject)) return notFound();
    const page = pageForSubject(target.subject, target.view, languages);
    if (!page) return notFound();
    return {
      status: 200,
      ...page,
      zone: recipeZone(state),
    };
  }

  if (target.route !== '') return notFound();
  return { status: 200, ...recipeHomeResponse(state, languages) };
};

const pageRead: NonNullable<FakeRoute['story']> = async ({ request }) => {
  const input = await readInput(request);
  const target = input?.target;
  if (!isRecord(target) || typeof target.subject !== 'string') return undefined;
  const page = pageForSubject(target.subject, target.view, requestedLanguages(input, request));
  return page ? { status: 200, ...page } : undefined;
};

const subjectRead: NonNullable<FakeRoute['story']> = ({ request, match }) => {
  const candidate = recipeCandidate(match?.[1] ? decodeURIComponent(match[1]) : '');
  return candidate
    ? {
        status: 200,
        ...recipeSubjectRead(candidate, requestedLanguages(undefined, request)),
      }
    : undefined;
};

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: /^\/v1\/zones\/([^/]+):readPage$/,
    story: zoneRead,
  },
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: pageRead,
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)$/,
    story: subjectRead,
  },
];
