import type { SubjectRead } from '@rezics/client';
import {
  PAGE_GLOBAL_CONTEXT,
  definedViews,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type PageRead,
  type PresentationProfile,
  type SelectedContext,
} from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import profileJson from '@rezics/composition/profiles/platform.json';
import type { CompositionDocument } from '@rezics/composition';
import type { SubjectPageData } from '../../features/pages/page-model';
import definitions from '../recorded/definitions-release.json';
import { communityThreadPage } from './subject-community';
import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import {
  SERIES_CANDIDATE_DOCUMENTS,
  SERIES_CANDIDATE_IDS,
  SERIES_CANDIDATE_ROUTES,
  SERIES_CANDIDATE_SUBJECTS,
  seriesCandidateSubject,
  seriesCandidateZone,
  seriesCandidateZonePage,
} from '../../zones/candidates/series';

const profile = profileJson as PresentationProfile;
const release = definitions.release as Release;
const releasedTypes = release.types as Record<string, { bases: string[] }>;
const releasedProperties = release.properties as Record<string, { relation?: { inverse?: string | null } }>;
const allZoneIds = new Set<string>(Object.values(SERIES_CANDIDATE_IDS));
const zonePath = /^\/v1\/zones\/([^/]+):readPage$/;
const subjectPath = new RegExp(`^/v1/subjects/(${SERIES_CANDIDATE_SUBJECTS.map(({ id }) => id).join('|')})$`);
const fixtureTime = '2026-10-26T00:00:00.000Z';
const freshness = {
  consistency: 'eventual',
  target_seconds: 10,
  caught_up: true,
};

const notFound: KernelRecording = {
  status: 404,
  type: 'https://rezics.com/problems/not_found',
  title: 'Not Found',
  code: 'not_found',
  detail: 'This Zone could not be found.',
  retryable: false,
  effect_status: 'not_applicable',
  request_id: 'series-zone-not-found',
  headers: { 'cache-control': 'no-store' },
};

const platformClosed: KernelRecording = {
  status: 403,
  type: 'https://rezics.com/problems/platform_closed',
  title: 'Platform Closed',
  code: 'platform_closed',
  detail: 'Source reads are closed for this development preview.',
  retryable: false,
  effect_status: 'not_applicable',
  request_id: 'series-platform-closed',
  headers: { 'cache-control': 'no-store' },
};

const semanticNotReady: KernelRecording = {
  status: 503,
  type: 'https://rezics.com/problems/semantic_not_ready',
  title: 'Service Unavailable',
  code: 'semantic_not_ready',
  detail: 'The semantic source for this development preview is not ready yet.',
  retryable: true,
  effect_status: 'not_applicable',
  request_id: 'series-semantic-not-ready',
  headers: { 'Retry-After': '1', 'cache-control': 'no-store' },
};

type CandidateSubject = (typeof SERIES_CANDIDATE_SUBJECTS)[number];

type RequestInput = {
  target: Record<string, unknown>;
  languages?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestInput(request: Request): Promise<RequestInput | undefined> {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body) || !isRecord(body.target)) return undefined;
    return {
      target: body.target,
      ...(Array.isArray(body.languages)
        ? {
            languages: body.languages.filter((value): value is string => typeof value === 'string'),
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function isSeriesRoute(route: string): route is (typeof SERIES_CANDIDATE_ROUTES)[number] {
  return (SERIES_CANDIDATE_ROUTES as readonly string[]).includes(route);
}

function routeDocument(route: (typeof SERIES_CANDIDATE_ROUTES)[number]): CompositionDocument {
  if (route === '') return SERIES_CANDIDATE_DOCUMENTS.home;
  if (route === 'book-series') return SERIES_CANDIDATE_DOCUMENTS.bookSeries;
  return SERIES_CANDIDATE_DOCUMENTS.creativeWorks;
}

function subjectTypes(subject: CandidateSubject): string[] {
  const definition = releasedTypes[subject.type];
  if (!definition) throw new Error(`The released definitions are missing ${subject.type}.`);
  return [subject.type, ...definition.bases];
}

function subjectLabel(subject: CandidateSubject, languages: readonly string[] = []) {
  const language = languages.find((candidate) => candidate === 'en') ?? 'en';
  return { value: subject.label, language };
}

function subjectSummary(
  subject: CandidateSubject,
  languages: readonly string[] = [],
): NonNullable<SubjectRead['summary']> {
  const types = subjectTypes(subject);
  return {
    id: subject.id,
    type: subject.type,
    types,
    creativeWork: types.includes('schema:CreativeWork'),
    label: subjectLabel(subject, languages),
    cover: null,
  };
}

function subjectRead(
  subject: CandidateSubject,
  context = PAGE_GLOBAL_CONTEXT,
  languages: readonly string[] = [],
): SubjectRead {
  const label = subjectLabel(subject, languages);
  const row: SubjectRead['subject'] = {
    id: subject.id,
    type: subject.type,
    revision: 1,
    release: definitions.digest,
    context,
    resolution: {},
    relationCounts: {},
    labels: { [label.language]: label.value },
    descriptions: { [label.language]: subject.description },
    aliases: {},
    statements: {},
    sourceRecords: [],
  };
  return {
    subject: row,
    account: null,
    related: {},
    summary: subjectSummary(subject, languages),
  };
}

function searchBody(subjects: readonly CandidateSubject[], languages: readonly string[] = []) {
  const rows = [...subjects]
    .sort((left, right) =>
      left.label < right.label ? -1 : left.label > right.label ? 1 : left.id.localeCompare(right.id),
    )
    .map((subject) => {
      const label = subjectLabel(subject, languages);
      return {
        id: subject.id,
        type: subject.type,
        labels: { [label.language]: label.value },
        summary: subjectSummary(subject, languages),
      };
    });
  return { subjects: rows, next: null, as_of: fixtureTime };
}

function matchesTypeFilter(read: Extract<PageRead, { kind: 'search' }>, subject: CandidateSubject): boolean {
  const matches = (filter: Extract<PageRead, { kind: 'search' }>['body']['filter']): boolean => {
    if ('type' in filter) return filter.type.in.includes(subject.type);
    if ('and' in filter) return filter.and.every(matches);
    if ('or' in filter) return filter.or.some(matches);
    if ('not' in filter) return !matches(filter.not);
    return false;
  };
  return matches(read.body.filter);
}

function zoneReads(
  document: CompositionDocument,
  candidates: readonly CandidateSubject[],
  languages: readonly string[] = [],
) {
  const plan = planReads(platformRegistry, document, { subject: null });
  return Object.fromEntries(
    Object.entries(plan.reads).map(([key, read]) => [
      key,
      read.kind === 'search'
        ? {
            status: 200,
            body: searchBody(
              candidates.filter((candidate) => matchesTypeFilter(read, candidate)),
              languages,
            ),
          }
        : { status: 204, body: null },
    ]),
  );
}

function previewSubjectDocument(document: CompositionDocument): CompositionDocument {
  return {
    ...document,
    content: [
      ...document.content,
      {
        type: 'Text',
        props: {
          id: 'series-development-preview-note',
          text: 'Gated development preview: this fictional record states no series membership or ordering facts.',
        },
      },
    ],
  };
}

function emptyPageRead(read: PageRead, subject: CandidateSubject, languages: readonly string[]): unknown {
  if (read.kind === 'subject') return subjectRead(subject, read.context ?? PAGE_GLOBAL_CONTEXT, languages);
  if (read.kind === 'search') return searchBody([], languages);
  if (read.kind === 'links' || read.kind === 'relations') {
    return {
      [read.kind]: [],
      count: { value: 0, exact: true },
      next: null,
      freshness,
    };
  }
  if (read.kind === 'subjectThreads') {
    return communityThreadPage(read.threadKind, { id: subject.id, label: subject.label }, [], null, read.place);
  }
  if (read.kind === 'collections') return { collections: [], count: { value: 0, exact: true }, next: null };
  if (read.kind === 'members') return { members: [], count: { value: 0, exact: true }, next: null };
  return null;
}

function subjectPage(
  subject: CandidateSubject,
  requestedView: unknown = 'overview',
  languages: readonly string[] = [],
): SubjectPageData | undefined {
  const typeDefinition = releasedTypes[subject.type];
  if (!typeDefinition) return undefined;
  const target = { type: subject.type, bases: typeDefinition.bases };
  const views = definedViews(profile, target);
  const view = views.find((candidate) => candidate === requestedView);
  if (!view) return undefined;
  const resolved = resolveView(profile, target, view);
  if (!resolved) return undefined;
  const context: SelectedContext = {
    id: PAGE_GLOBAL_CONTEXT,
    population: { kind: 'global' },
  };
  const document = previewSubjectDocument(resolved.document);
  const plan = planReads(platformRegistry, document, {
    subject: subject.id,
    context,
  });
  const reads: SubjectPageData['reads'] = {};
  const directions: NonNullable<NonNullable<SubjectPageData['catalogue']>['directions']> = [];
  const seenDirections = new Set<string>();
  for (const read of Object.values(plan.reads)) {
    if (read.kind !== 'links' && read.kind !== 'relations') continue;
    const direction = read.kind === 'links' ? 'inverse' : 'forward';
    const key = `${read.property}:${direction}`;
    if (seenDirections.has(key)) continue;
    seenDirections.add(key);
    directions.push({
      state: 'admitted',
      property: read.property,
      direction,
      inverse: releasedProperties[read.property]?.relation?.inverse ?? null,
      sourceTypes: [],
      targetTypes: [],
      release: definitions.digest,
      qualifiers: [],
    });
  }
  for (const [key, read] of Object.entries(plan.reads))
    reads[key] = {
      status: 200,
      body: emptyPageRead(read, subject, languages),
    };
  return {
    subject: subject.id,
    context,
    profile: profileDigest(profile),
    template: { scope: resolved.scope, key: resolved.key },
    document,
    views,
    catalogue: {
      state: 'released',
      type: subject.type,
      digest: definitions.digest,
      definitions: release,
      directions,
    },
    reads,
  };
}

function sourceGate(id: string): KernelRecording | undefined {
  if (id === SERIES_CANDIDATE_IDS.platformClosed) return platformClosed;
  if (id === SERIES_CANDIDATE_IDS.semanticNotReady) return semanticNotReady;
  if (id === SERIES_CANDIDATE_IDS.private || id === SERIES_CANDIDATE_IDS.missing) return notFound;
  return undefined;
}

function zoneRoutePage(id: string, route: string, languages: readonly string[]): KernelRecording | undefined {
  if (!isSeriesRoute(route)) return notFound;
  if (id === SERIES_CANDIDATE_IDS.preview) {
    const document = routeDocument(route);
    const candidates = route === '' ? SERIES_CANDIDATE_SUBJECTS : [];
    const reads = route === '' ? zoneReads(document, candidates, languages) : {};
    return {
      status: 200,
      ...seriesCandidateZonePage(id, route, document, reads),
    };
  }
  if (route !== '') return notFound;
  if (id === SERIES_CANDIDATE_IDS.readyEmpty) {
    const document = SERIES_CANDIDATE_DOCUMENTS.readyEmpty;
    return {
      status: 200,
      ...seriesCandidateZonePage(id, route, document, zoneReads(document, [], languages)),
    };
  }
  if (id === SERIES_CANDIDATE_IDS.sparse) {
    const document = SERIES_CANDIDATE_DOCUMENTS.sparse;
    return {
      status: 200,
      ...seriesCandidateZonePage(id, route, document, zoneReads(document, [SERIES_CANDIDATE_SUBJECTS[0]], languages)),
    };
  }
  return notFound;
}

async function zoneSubjectPage(
  id: string,
  subjectId: string,
  view: unknown,
  languages: readonly string[],
): Promise<KernelRecording> {
  if (id !== SERIES_CANDIDATE_IDS.preview) return notFound;
  const candidate = seriesCandidateSubject(subjectId);
  if (!candidate) return notFound;
  const page = subjectPage(candidate, view, languages);
  if (!page) return notFound;
  return {
    status: 200,
    ...page,
    zone: seriesCandidateZone(id),
  };
}

async function zoneRead(request: Request, id: string): Promise<KernelRecording | undefined> {
  if (!allZoneIds.has(id)) return undefined;
  const gate = sourceGate(id);
  if (gate) return gate;
  const input = await requestInput(request);
  if (!input) return { status: 400, code: 'invalid_request' };
  if (typeof input.target.route === 'string') return zoneRoutePage(id, input.target.route, input.languages ?? []);
  if (typeof input.target.subject === 'string')
    return zoneSubjectPage(id, input.target.subject, input.target.view, input.languages ?? []);
  return { status: 400, code: 'invalid_target' };
}

async function globalSubjectPage(request: Request): Promise<KernelRecording | undefined> {
  const input = await requestInput(request);
  if (!input || typeof input.target.subject !== 'string') return undefined;
  const candidate = seriesCandidateSubject(input.target.subject);
  if (!candidate) return undefined;
  const page = subjectPage(candidate, input.target.view, input.languages ?? []);
  return page ? { status: 200, ...page } : notFound;
}

function globalSubject(request: Request): KernelRecording | undefined {
  const match = subjectPath.exec(new URL(request.url).pathname);
  const candidate = match?.[1] ? seriesCandidateSubject(match[1]) : undefined;
  return candidate ? { status: 200, ...subjectRead(candidate) } : undefined;
}

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: zonePath,
    story: ({ request, match }) => (match?.[1] ? zoneRead(request, decodeURIComponent(match[1])) : undefined),
    fixture: ({ request, match }) => (match?.[1] ? zoneRead(request, decodeURIComponent(match[1])) : undefined),
  },
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: ({ request }) => globalSubjectPage(request),
    fixture: ({ request }) => globalSubjectPage(request),
  },
  {
    method: 'GET',
    path: subjectPath,
    story: ({ request }) => globalSubject(request),
    fixture: ({ request }) => globalSubject(request),
  },
];
