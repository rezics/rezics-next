import type { KernelRecording } from "../fake.ts";
import type { FakeRoute } from "../fake-modules.ts";
import {
  SERIES_CANDIDATE_IDS,
  SERIES_CANDIDATE_PAGES,
  SERIES_CANDIDATE_SUBJECTS,
  SERIES_CANDIDATE_DOCUMENTS,
  seriesCandidateSubject,
  seriesCandidateZone,
} from "../../zones/candidates/series";

const zoneIds = Object.values(SERIES_CANDIDATE_IDS);
const zonePath = new RegExp(`^/v1/zones/(${zoneIds.join("|")}):readPage$`);
const subjectPath = new RegExp(
  `^/v1/subjects/(${SERIES_CANDIDATE_SUBJECTS.map(({ id }) => id).join("|")})$`,
);
const notFound: KernelRecording = {
  status: 404,
  code: "not_found",
  detail: "This Zone could not be found.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestTarget(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.clone().json();
    return isRecord(body) && isRecord(body.target) ? body.target : undefined;
  } catch {
    return undefined;
  }
}

function pageForRoute(id: string, route: string): KernelRecording | undefined {
  if (id === SERIES_CANDIDATE_IDS.preview) {
    if (route === "") return { status: 200, ...SERIES_CANDIDATE_PAGES.preview };
    if (route === "book-series")
      return { status: 200, ...SERIES_CANDIDATE_PAGES.bookSeries };
    if (route === "creative-works")
      return { status: 200, ...SERIES_CANDIDATE_PAGES.creativeWorks };
    return notFound;
  }
  if (id === SERIES_CANDIDATE_IDS.readyEmpty && route === "")
    return { status: 200, ...SERIES_CANDIDATE_PAGES.readyEmpty };
  if (id === SERIES_CANDIDATE_IDS.sparse && route === "")
    return { status: 200, ...SERIES_CANDIDATE_PAGES.sparse };
  if (id === SERIES_CANDIDATE_IDS.platformClosed)
    return {
      status: 403,
      code: "platform_closed",
      detail: "Source reads are closed for this development preview.",
    };
  if (id === SERIES_CANDIDATE_IDS.semanticNotReady)
    return {
      status: 503,
      headers: { "Retry-After": "1" },
      code: "semantic_not_ready",
      detail:
        "The semantic source for this development preview is not ready yet.",
    };
  if (
    id === SERIES_CANDIDATE_IDS.private ||
    id === SERIES_CANDIDATE_IDS.missing
  )
    return notFound;
  return undefined;
}

function zoneSubjectPage(
  id: string,
  subjectId: string,
): KernelRecording | undefined {
  if (id !== SERIES_CANDIDATE_IDS.preview) return notFound;
  const subject = seriesCandidateSubject(subjectId);
  if (!subject) return notFound;
  return {
    status: 200,
    profile: "development-preview:series",
    template: { scope: "base", key: subject.type },
    document: SERIES_CANDIDATE_DOCUMENTS.subject(
      subject.label,
      subject.description,
    ),
    reads: {},
    zone: seriesCandidateZone(id),
    subject: subject.id,
    views: ["overview"],
  };
}

function zoneRead(
  request: Request,
  id: string,
): Promise<KernelRecording | undefined> {
  return requestTarget(request).then((target) => {
    if (!target) return { status: 400, code: "invalid_request" };
    if (typeof target.route === "string") return pageForRoute(id, target.route);
    if (typeof target.subject === "string")
      return zoneSubjectPage(id, target.subject);
    return { status: 400, code: "invalid_target" };
  });
}

async function globalSubjectPage(
  request: Request,
): Promise<KernelRecording | undefined> {
  const target = await requestTarget(request);
  if (!target || typeof target.subject !== "string") return undefined;
  const subject = seriesCandidateSubject(target.subject);
  if (!subject) return undefined;
  return {
    status: 200,
    subject: subject.id,
    profile: "development-preview:series",
    template: { scope: "base", key: subject.type },
    document: SERIES_CANDIDATE_DOCUMENTS.subject(
      subject.label,
      subject.description,
    ),
    reads: {},
    views: ["overview"],
  };
}

function globalSubject(request: Request): KernelRecording | undefined {
  const match = subjectPath.exec(new URL(request.url).pathname);
  const subject = match?.[1] ? seriesCandidateSubject(match[1]) : undefined;
  if (!subject) return undefined;
  return {
    status: 200,
    account: null,
    subject: {
      id: subject.id,
      type: subject.type,
      revision: 1,
      labels: { en: subject.label },
      descriptions: { en: subject.description },
      aliases: {},
      statements: {},
    },
  };
}

export const routes: FakeRoute[] = [
  {
    method: "POST",
    path: zonePath,
    story: ({ request, match }) =>
      match?.[1] ? zoneRead(request, match[1]) : undefined,
    fixture: ({ request, match }) =>
      match?.[1] ? zoneRead(request, match[1]) : undefined,
  },
  {
    method: "POST",
    path: "/v1/pages:read",
    story: ({ request }) => globalSubjectPage(request),
    fixture: ({ request }) => globalSubjectPage(request),
  },
  {
    method: "GET",
    path: subjectPath,
    story: ({ request }) => globalSubject(request),
    fixture: ({ request }) => globalSubject(request),
  },
];
