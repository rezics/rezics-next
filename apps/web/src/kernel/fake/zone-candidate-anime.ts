import type { KernelRecording } from "../fake";
import type { FakeRoute } from "../fake-modules";
import {
  animeCandidateIds,
  animeCandidatePage,
  animeCandidateReads,
  animeCandidateSubject,
  animeCandidateSubjectPage,
  type AnimeRoute,
} from "../../zones/candidates/anime";

const zoneIds = new Set<string>(Object.values(animeCandidateIds));
const routeNames = new Set<AnimeRoute>(["", "films", "releases", "series"]);

function reply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): KernelRecording {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body,
  } as KernelRecording;
}

function pageFor(id: string, route: AnimeRoute) {
  if (route === "") {
    if (id === animeCandidateIds.readyEmpty)
      return animeCandidatePage(id, route, animeCandidateReads.readyEmpty);
    if (id === animeCandidateIds.sparse)
      return animeCandidatePage(id, route, animeCandidateReads.sparse);
    return animeCandidatePage(id, route, animeCandidateReads.admittedPreview);
  }
  if (route === "releases")
    return animeCandidatePage(id, route, animeCandidateReads.releases);
  return animeCandidatePage(id, route);
}

export const routes: FakeRoute[] = [
  {
    method: "POST",
    path: /^\/zones\/([^/]+):readPage$/,
    story: async ({ request, match }) => {
      const id = match?.[1];
      if (!id || !zoneIds.has(id)) return undefined;
      if (id === animeCandidateIds.concealed) {
        return reply(404, {
          code: "not_found",
          message: "This page is unavailable.",
        });
      }

      let input: unknown;
      try {
        input = await request.json();
      } catch {
        return reply(404, {
          code: "not_found",
          message: "This page is unavailable.",
        });
      }
      if (!input || typeof input !== "object")
        return reply(404, {
          code: "not_found",
          message: "This page is unavailable.",
        });

      const target = (input as { target?: unknown }).target;
      if (!target || typeof target !== "object")
        return reply(404, {
          code: "not_found",
          message: "This page is unavailable.",
        });
      const candidateTarget = target as { route?: unknown; subject?: unknown };
      if (typeof candidateTarget.subject === "string") {
        const subject = animeCandidateSubject(candidateTarget.subject);
        if (!subject) return undefined;
        if (id === animeCandidateIds.platformClosed) {
          return reply(403, {
            code: "platform_closed",
            message:
              "Anime source browsing is gated in this development preview.",
          });
        }
        if (id === animeCandidateIds.semanticUnavailable) {
          return reply(
            503,
            {
              code: "semantic_not_ready",
              message: "Anime source data is not ready. Retry shortly.",
            },
            { "Retry-After": "1" },
          );
        }
        return reply(200, animeCandidateSubjectPage(id, subject));
      }

      if (
        typeof candidateTarget.route !== "string" ||
        !routeNames.has(candidateTarget.route as AnimeRoute)
      ) {
        return reply(404, {
          code: "not_found",
          message: "This page is unavailable.",
        });
      }
      const route = candidateTarget.route as AnimeRoute;
      if (route === "" || route === "releases") {
        if (id === animeCandidateIds.platformClosed) {
          return reply(403, {
            code: "platform_closed",
            message:
              "Anime source browsing is gated in this development preview.",
          });
        }
        if (id === animeCandidateIds.semanticUnavailable) {
          return reply(
            503,
            {
              code: "semantic_not_ready",
              message: "Anime source data is not ready. Retry shortly.",
            },
            { "Retry-After": "1" },
          );
        }
      }
      return reply(200, pageFor(id, route));
    },
  },
];
