import type { SubjectRead } from '@rezics/client';
import {
  PAGE_GLOBAL_CONTEXT,
  definedViews,
  isView,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type CompositionDocument,
  type PresentationProfile,
  type SelectedContext,
  type View,
} from '@rezics/composition';
import profileJson from '@rezics/composition/profiles/platform.json';
import definitions from '../recorded/definitions-release.json';
import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import type { ZonePageResponse, ZonePageTemplate } from '../../zones/appearance.ts';
import {
  mangaCandidateDocument,
  mangaCandidateIds,
  mangaCandidateShell,
  mangaCandidateSubjects,
} from '../../zones/candidates/manga';

type CandidateState = keyof typeof mangaCandidateIds;
type CandidateSubject = (typeof mangaCandidateSubjects)[number];
type ReadResult = { status: number; body: unknown };
type MangaSubjectPage = {
  subject: string;
  context: SelectedContext;
  profile: string;
  template: ZonePageTemplate;
  document: CompositionDocument;
  views: View[];
  catalogue: {
    state: 'released';
    type: string;
    digest: string;
    definitions: typeof definitions.release;
    directions: [];
  };
  reads: Record<string, ReadResult>;
};

const profile = profileJson as PresentationProfile;
const releasedTypes = definitions.release.types as Record<string, { bases: string[] }>;
const typeByZone = new Map<string, CandidateState>(
  Object.entries(mangaCandidateIds).map(([state, id]) => [id, state as CandidateState]),
);

function subjectTypes(subject: CandidateSubject): string[] {
  return [subject.type, ...(releasedTypes[subject.type]?.bases ?? [])];
}

function subjectSummary(subject: CandidateSubject): NonNullable<SubjectRead['summary']> {
  const types = subjectTypes(subject);
  return {
    id: subject.id,
    type: subject.type,
    types,
    creativeWork: types.includes('schema:CreativeWork'),
    label: { value: subject.label, language: 'en' },
    cover: null,
  };
}

function mangaSubjectRead(subject: CandidateSubject, context = PAGE_GLOBAL_CONTEXT): SubjectRead {
  return {
    subject: {
      id: subject.id,
      type: subject.type,
      revision: 1,
      release: definitions.digest,
      context,
      resolution: {},
      relationCounts: {},
      labels: { en: subject.label },
      descriptions: {},
      aliases: {},
      statements: {},
      sourceRecords: [],
    },
    summary: subjectSummary(subject),
    related: {},
    account: null,
  };
}

function emptyRead(read: { kind: string }): ReadResult {
  const count = { value: 0, exact: true };
  if (read.kind === 'links') return { status: 200, body: { links: [], count, next: null } };
  if (read.kind === 'relations') return { status: 200, body: { relations: [], count, next: null } };
  if (read.kind === 'collections') return { status: 200, body: { collections: [], count, next: null } };
  if (read.kind === 'members') return { status: 200, body: { members: [], count, next: null } };
  if (read.kind === 'search') return { status: 200, body: { subjects: [], next: null } };
  return { status: 204, body: null };
}

function subjectPage(subject: CandidateSubject, view: View = 'overview'): MangaSubjectPage | undefined {
  const type = releasedTypes[subject.type];
  if (!type) return undefined;
  const target = { type: subject.type, bases: type.bases };
  const resolved = resolveView(profile, target, view);
  if (!resolved) return undefined;

  const context: SelectedContext = { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' } };
  const plan = planReads(platformRegistry, resolved.document, { subject: subject.id, context });
  const ownRead = mangaSubjectRead(subject, context.id);
  const reads: Record<string, ReadResult> = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    reads[key] = read.kind === 'subject' ? { status: 200, body: ownRead } : emptyRead(read);
  }

  return {
    subject: subject.id,
    context,
    profile: profileDigest(profile),
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    views: definedViews(profile, target),
    catalogue: {
      state: 'released',
      type: subject.type,
      digest: definitions.digest,
      definitions: definitions.release,
      directions: [],
    },
    reads,
  };
}

function subjectsForState(state: CandidateState): readonly CandidateSubject[] {
  if (state === 'preview') return mangaCandidateSubjects;
  if (state === 'sparse') return mangaCandidateSubjects.slice(0, 1);
  return [];
}

function homeReads(document: CompositionDocument, state: CandidateState): ZonePageResponse['reads'] {
  const plan = planReads(platformRegistry, document, { subject: null });
  const key = plan.nodes.works;
  const descriptor = key ? plan.reads[key] : undefined;
  const reads: ZonePageResponse['reads'] = {};
  for (const [readKey, read] of Object.entries(plan.reads)) {
    reads[readKey] =
      readKey === key && read.kind === 'search'
        ? {
            status: 200,
            body: {
              subjects: subjectsForState(state).map((subject) => ({
                id: subject.id,
                type: subject.type,
                labels: { en: subject.label },
                summary: subjectSummary(subject),
              })),
              next: null,
            },
          }
        : emptyRead(read);
  }
  return descriptor?.kind === 'search' ? reads : {};
}

function problem(status: number, code: string, title: string, headers?: Record<string, string>): KernelRecording {
  return {
    status,
    type: `https://rezics.com/problems/${code}`,
    title,
    code,
    retryable: status === 503,
    effect_status: 'not_applicable',
    request_id: `manga-candidate-${code}`,
    headers: { 'cache-control': 'no-store', ...headers },
  };
}

function notFound(): KernelRecording {
  return problem(404, 'not_found', 'Not Found');
}

function invalidRequest(): KernelRecording {
  return problem(400, 'invalid_request', 'Bad Request');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function routePage(id: string, route: string, state: CandidateState): KernelRecording | undefined {
  const document = mangaCandidateDocument(route);
  if (!document) return undefined;
  return {
    status: 200,
    profile: profileDigest(profile),
    template: { scope: 'route', key: route },
    document,
    reads: route === '' ? homeReads(document, state) : {},
    zone: mangaCandidateShell(id),
  };
}

async function zonePageAnswer(id: string, request: Request): Promise<KernelRecording | undefined> {
  const state = typeByZone.get(id);
  if (!state) return undefined;
  if (state === 'concealed') return notFound();

  const input = await jsonBody(request);
  if (!input || !isRecord(input.target)) return invalidRequest();
  const target = input.target;

  if (Object.keys(target).length === 1 && typeof target.route === 'string') {
    if (target.route !== '' && target.route !== 'volumes') return notFound();
    if (target.route === '' && state === 'closed') return problem(403, 'platform_closed', 'Platform Closed');
    if (target.route === '' && state === 'unavailable')
      return problem(503, 'semantic_not_ready', 'Service Unavailable', { 'retry-after': '1' });
    return routePage(id, target.route, state);
  }

  if (
    (Object.keys(target).length === 1 || Object.keys(target).length === 2) &&
    typeof target.subject === 'string' &&
    (Object.keys(target).length === 1 || Object.keys(target).includes('view'))
  ) {
    if (state === 'closed') return problem(403, 'platform_closed', 'Platform Closed');
    if (state === 'unavailable')
      return problem(503, 'semantic_not_ready', 'Service Unavailable', { 'retry-after': '1' });
    const subject = subjectsForState(state).find((candidate) => candidate.id === target.subject);
    const view = target.view === undefined ? 'overview' : isView(target.view) ? target.view : undefined;
    if (!subject || !view) return notFound();
    const page = subjectPage(subject, view);
    if (!page) return notFound();
    return {
      status: 200,
      profile: page.profile,
      template: page.template,
      document: page.document,
      reads: page.reads,
      zone: mangaCandidateShell(id),
      subject: subject.id,
      views: page.views,
    };
  }

  return invalidRequest();
}

async function subjectPageAnswer(request: Request): Promise<KernelRecording | undefined> {
  const input = await jsonBody(request);
  if (!input || !isRecord(input.target)) return undefined;
  const target = input.target;
  const keys = Object.keys(target);
  if (
    (keys.length !== 1 && keys.length !== 2) ||
    !keys.includes('subject') ||
    (keys.length === 2 && !keys.includes('view')) ||
    typeof target.subject !== 'string'
  )
    return undefined;
  const subject = mangaCandidateSubjects.find((candidate) => candidate.id === target.subject);
  const view = target.view === undefined ? 'overview' : isView(target.view) ? target.view : undefined;
  if (!subject || !view) return undefined;
  const page = subjectPage(subject, view);
  return page ? { status: 200, ...page } : undefined;
}

function publicSubjectAnswer(subjectId: string): KernelRecording | undefined {
  const subject = mangaCandidateSubjects.find((candidate) => candidate.id === subjectId);
  return subject ? { status: 200, ...mangaSubjectRead(subject) } : undefined;
}

const zoneRoutes: FakeRoute[] = Object.values(mangaCandidateIds).map((id) => ({
  method: 'POST',
  path: `/v1/zones/${id}:readPage`,
  story: ({ request }) => zonePageAnswer(id, request),
}));

export const routes: FakeRoute[] = [
  ...zoneRoutes,
  { method: 'POST', path: '/v1/pages:read', story: ({ request }) => subjectPageAnswer(request) },
  ...mangaCandidateSubjects.map(({ id }) => ({
    method: 'GET',
    path: `/v1/subjects/${id}`,
    story: () => publicSubjectAnswer(id),
  })),
];
