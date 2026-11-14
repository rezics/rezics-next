import type { SubjectRead } from "@rezics/client";
import {
  PAGE_GLOBAL_CONTEXT,
  definedViews,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type CompositionDocument,
  type PageRead,
  type PresentationProfile,
  type SelectedContext,
  type View,
} from "@rezics/composition";
import profileJson from "@rezics/composition/profiles/platform.json";
import type { Release } from "@rezics/definitions";
import type { SubjectPageData } from "../../features/pages/subject";
import type { KernelRecording } from "../fake";
import definitions from "../recorded/definitions-release.json";
import type { FakeRoute } from "../fake-modules";
import {
  animeCandidateIds,
  animeCandidatePage,
  animeCandidateReads,
  animeCandidateRows,
  animeCandidateSubject,
  animeCandidateZone,
  type AnimeCandidateSubject,
  type AnimeRoute,
} from "../../zones/candidates/anime";
import type { ZonePageRequest, ZonePageResponse } from "../../zones/appearance";

const zoneIds = new Set<string>(Object.values(animeCandidateIds));
const routeNames = new Set<AnimeRoute>(["", "films", "releases", "series"]);
const profile = profileJson as PresentationProfile;
const profileId = profileDigest(profile);
const release = definitions.release as Release;
const releaseTypes = release.types as Record<string, { bases: string[] }>;
const globalContext: SelectedContext = {
  id: PAGE_GLOBAL_CONTEXT,
  population: { kind: "global" },
};
const freshness = {
  consistency: "eventual",
  target_seconds: 10,
  caught_up: true,
};
const fixtureTime = "2026-10-26T00:00:00.000Z";

function problem(
  status: number,
  code:
    "not_found" | "platform_closed" | "semantic_not_ready" | "invalid_request",
  retryable = false,
): KernelRecording {
  const title =
    code === "platform_closed"
      ? "Platform Closed"
      : code === "semantic_not_ready"
        ? "Service Unavailable"
        : code === "invalid_request"
          ? "Bad Request"
          : "Not Found";
  return {
    status,
    headers: {
      "cache-control": "no-store",
      ...(code === "semantic_not_ready" ? { "retry-after": "1" } : {}),
    },
    type: `https://rezics.com/problems/${code}`,
    title,
    code,
    retryable,
    effect_status: "not_applicable",
    request_id: `anime-${code}`,
  };
}

function subjectSummary(
  item: AnimeCandidateSubject,
  languages: string[] = [],
): NonNullable<SubjectRead["summary"]> {
  const types = [item.type, ...releaseTypes[item.type]!.bases];
  const language =
    languages.find((candidate) => candidate in item.labels) ?? "en";
  return {
    id: item.id,
    type: item.type,
    types,
    label: {
      value: item.labels[language as keyof typeof item.labels],
      language,
    },
    creativeWork: types.includes("schema:CreativeWork"),
    cover: null,
  };
}

function subjectRead(
  item: AnimeCandidateSubject,
  context = PAGE_GLOBAL_CONTEXT,
  languages: string[] = [],
): SubjectRead {
  const subject: SubjectRead["subject"] = {
    id: item.id,
    type: item.type,
    revision: 1,
    release: definitions.digest,
    context,
    resolution: {},
    relationCounts: {},
    labels: item.labels,
    descriptions: {},
    aliases: {},
    statements: {},
    sourceRecords: [],
  };
  return {
    subject,
    summary: subjectSummary(item, languages),
    related: {},
    account: null,
  };
}

function searchHit(item: AnimeCandidateSubject) {
  return {
    id: item.id,
    type: item.type,
    labels: item.labels,
    summary: subjectSummary(item),
  };
}

function rowsForRead(zoneId: string, route: AnimeRoute, node: string) {
  if (route === "" && node === "works") {
    if (zoneId === animeCandidateIds.readyEmpty)
      return animeCandidateReads.readyEmpty;
    if (zoneId === animeCandidateIds.sparse) return animeCandidateReads.sparse;
    return animeCandidateReads.admittedPreview;
  }
  if (route === "releases" && node === "releases")
    return animeCandidateReads.releases;
  return [];
}

function plannedZoneReads(zoneId: string, route: AnimeRoute) {
  const page = animeCandidatePage(zoneId, route, profileId, {});
  const plan = planReads(
    platformRegistry,
    page.document as CompositionDocument,
    {
      subject: null,
    },
  );
  const reads: Record<string, unknown> = {};
  for (const [node, key] of Object.entries(plan.nodes)) {
    const descriptor = plan.reads[key];
    if (descriptor?.kind !== "search") continue;
    reads[key] = {
      status: 200,
      body: {
        subjects: rowsForRead(zoneId, route, node).map(searchHit),
        next: null,
        as_of: fixtureTime,
      },
    };
  }
  return reads;
}

function emptySubjectRead(
  read: PageRead,
  item: AnimeCandidateSubject,
  languages: string[],
) {
  if (read.kind === "subject") {
    return {
      status: 200,
      body: subjectRead(item, read.context ?? PAGE_GLOBAL_CONTEXT, languages),
    };
  }
  if (read.kind === "links" || read.kind === "relations") {
    return {
      status: 200,
      body: {
        [read.kind]: [],
        count: 0,
        next: null,
        freshness,
      },
    };
  }
  if (read.kind === "search") {
    return {
      status: 200,
      body: { subjects: [], next: null, as_of: fixtureTime },
    };
  }
  if (read.kind === "collections") {
    return { status: 200, body: { collections: [], count: 0, next: null } };
  }
  if (read.kind === "members") {
    return { status: 200, body: { members: [], next: null } };
  }
  return { status: 204, body: null };
}

function subjectPageData(
  item: AnimeCandidateSubject,
  view: View = "overview",
  languages: string[] = [],
): SubjectPageData | undefined {
  const type = releaseTypes[item.type];
  if (!type) return;
  const target = { type: item.type, bases: type.bases };
  const resolved = resolveView(profile, target, view);
  if (!resolved) return;
  const views = definedViews(profile, target);
  if (!views.includes(view)) return;
  const plan = planReads(platformRegistry, resolved.document, {
    subject: item.id,
    context: globalContext,
  });
  const reads: SubjectPageData["reads"] = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    reads[key] = emptySubjectRead(read, item, languages);
  }
  return {
    subject: item.id,
    context: globalContext,
    profile: profileId,
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    views,
    catalogue: {
      state: "released",
      type: item.type,
      digest: definitions.digest,
      definitions: release,
      directions: [],
    },
    reads,
  };
}

function zoneSubjectPage(
  zoneId: string,
  item: AnimeCandidateSubject,
  view?: View,
  languages: string[] = [],
): ZonePageResponse | undefined {
  const page = subjectPageData(item, view, languages);
  if (!page) return;
  return {
    profile: page.profile,
    template: page.template,
    document: page.document,
    reads: page.reads,
    zone: animeCandidateZone(zoneId),
    subject: item.id,
    views: page.views,
  };
}

function problemForState(id: string): KernelRecording | undefined {
  if (id === animeCandidateIds.platformClosed)
    return problem(403, "platform_closed");
  if (id === animeCandidateIds.semanticUnavailable)
    return problem(503, "semantic_not_ready", true);
  return undefined;
}

function isDisplayedSubject(zoneId: string, subjectId: string): boolean {
  return [
    ...animeCandidateRows(zoneId, ""),
    ...animeCandidateRows(zoneId, "releases"),
  ].some((item) => item.id === subjectId);
}

async function zoneReadPage(
  request: Request,
  match: RegExpExecArray | null,
): Promise<KernelRecording | undefined> {
  const id = match?.[1];
  if (!id || !zoneIds.has(id)) return;
  if (id === animeCandidateIds.private || id === animeCandidateIds.missing)
    return problem(404, "not_found");

  let input: ZonePageRequest;
  try {
    input = (await request.json()) as ZonePageRequest;
  } catch {
    return problem(400, "invalid_request");
  }
  const target = input.target;
  if ("subject" in target) {
    const item = animeCandidateSubject(target.subject);
    if (!item || !isDisplayedSubject(id, item.id))
      return problem(404, "not_found");
    const denied = problemForState(id);
    if (denied) return denied;
    const view = target.view ?? "overview";
    if (view !== "overview" && view !== "details")
      return problem(404, "not_found");
    const page = zoneSubjectPage(id, item, view, input.languages ?? []);
    return page ? { status: 200, ...page } : problem(404, "not_found");
  }

  const route = target.route;
  if (!routeNames.has(route as AnimeRoute)) return problem(404, "not_found");
  const selectedRoute = route as AnimeRoute;
  if (selectedRoute === "" || selectedRoute === "releases") {
    const denied = problemForState(id);
    if (denied) return denied;
  }
  const page = animeCandidatePage(
    id,
    selectedRoute,
    profileId,
    plannedZoneReads(id, selectedRoute),
  );
  return { status: 200, ...page };
}

type PageInput = {
  target?: { subject?: unknown; view?: unknown };
  languages?: string[];
};

async function readSubjectPage(
  request: Request,
): Promise<KernelRecording | undefined> {
  let input: PageInput;
  try {
    input = (await request.json()) as PageInput;
  } catch {
    return;
  }
  const id = input.target?.subject;
  if (typeof id !== "string") return;
  const item = animeCandidateSubject(id);
  if (!item) return;
  const view = input.target?.view ?? "overview";
  if (view !== "overview" && view !== "details") return;
  const page = subjectPageData(item, view, input.languages ?? []);
  return page ? { status: 200, ...page } : undefined;
}

async function readCandidateSubject(
  request: Request,
  match: RegExpExecArray | null,
): Promise<KernelRecording | undefined> {
  const id = match?.[1];
  if (!id) return;
  const item = animeCandidateSubject(id);
  const requestedLanguage = request.headers
    .get("accept-language")
    ?.split(",", 1)[0]
    ?.split("-", 1)[0];
  return item
    ? {
        status: 200,
        ...subjectRead(
          item,
          PAGE_GLOBAL_CONTEXT,
          requestedLanguage ? [requestedLanguage] : [],
        ),
      }
    : undefined;
}

export const routes: FakeRoute[] = [
  {
    method: "POST",
    path: /^\/v1\/zones\/([^/]+):readPage$/,
    story: ({ request, match }) => zoneReadPage(request, match),
  },
  {
    method: "POST",
    path: "/v1/pages:read",
    story: ({ request }) => readSubjectPage(request),
  },
  {
    method: "GET",
    path: /^\/v1\/subjects\/([^/]+)$/,
    story: ({ request, match }) => readCandidateSubject(request, match),
  },
];
