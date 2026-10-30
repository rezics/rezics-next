import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as v from "valibot";
import {
  CollectionPage,
  collectionPageHead,
} from "../../library/collection-page";
import { DynamicCollectionPage } from "../../library/dynamic-collection-page";
import type { CollectionPageResult } from "../../library/collection-load";
import {
  collectionPageQuery,
  readCollectionPage,
  readDynamicCollectionMembers,
} from "../../library/collection-queries";
import { libraryTitleValue } from "../../library/title";
import { pageText } from "../../features/pages/shared";
import { m } from "../../paraglide/messages.js";
import { subjectHref } from "../../subject/subject-href";
import { pageHead, pageLinks } from "../../shell/head";
import { pageHeadContext } from "../../shell/head-context";
import { useSession } from "../../session/query";

export const Route = createFileRoute("/collections/$id")({
  staticData: { publicCache: true, sessionReread: true },
  validateSearch: (search: Record<string, unknown>) => {
    const { cursor } = v.parse(
      v.object({
        cursor: v.fallback(
          v.optional(v.pipe(v.string(), v.minLength(1))),
          undefined,
        ),
      }),
      search,
    );
    const filters: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(search))
      if (
        /^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) &&
        (typeof value === "string" ||
          (Array.isArray(value) &&
            value.every((entry) => typeof entry === "string")))
      )
        filters[key] = value as string | string[];
    const layout: "grid" | "list" | undefined =
      search.layout === "grid" || search.layout === "list"
        ? search.layout
        : undefined;
    return {
      ...(cursor === undefined ? {} : { cursor }),
      ...(layout ? { layout } : {}),
      ...(Object.keys(filters).length ? { filters } : {}),
    };
  },
  loaderDeps: ({ search }) => ({
    cursor: search.cursor,
    filters: search.filters,
  }),
  loader: ({ params, deps, context }) => {
    // Session-backed owner reads use private/no-store server data before client hydration.
    const credentialMode =
      typeof window === "undefined" ? "session" : context.credentialMode;
    return context.queryClient.ensureQueryData(
      collectionPageQuery(params.id, deps.cursor, credentialMode, deps.filters),
    );
  },
  head: ({ loaderData, match }) => {
    if (!loaderData)
      return pageHead(
        { title: m.not_found_heading() },
        pageHeadContext(match.pathname),
      );
    const context = pageHeadContext(match.pathname);
    const base = collectionPageHead(
      loaderData,
      context,
      loaderData.cursor !== undefined,
    );
    const title = pageText(
      libraryTitleValue(loaderData.title),
      context.locale,
    ).text;
    const canonical = pageLinks(
      context.origin,
      context.locale,
      context.path,
    )[0]!.href;
    const itemList =
      !("preparing" in loaderData) &&
      loaderData.publicExport &&
      loaderData.firstPage &&
      loaderData.next === null &&
      loaderData.cursor === undefined &&
      loaderData.filter === undefined
        ? {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: title,
            ...(loaderData.description
              ? { description: loaderData.description }
              : {}),
            url: canonical,
            itemListOrder: "https://schema.org/ItemListOrderAscending",
            numberOfItems: loaderData.members.filter(
              (member) => member.subject != null,
            ).length,
            itemListElement: loaderData.members
              .filter((member) => member.subject != null)
              .map((member, index) => {
                const subject = member.subject!;
                const label = pageText(
                  libraryTitleValue(subject.label),
                  context.locale,
                ).text;
                const itemPath = subjectHref(
                  { id: subject.id, label },
                  context.locale,
                ).href;
                return {
                  "@type": "ListItem",
                  position: index + 1,
                  item: {
                    "@id": new URL(itemPath, context.origin).href,
                    name: label,
                  },
                  ...(member.note ? { description: member.note } : {}),
                };
              }),
          }
        : undefined;
    const scripts =
      itemList === undefined
        ? []
        : pageHead({ title, jsonLd: itemList }, context).scripts;
    return { ...base, scripts };
  },
  component: CollectionRoute,
});

function CollectionRoute() {
  const initialPage = Route.useLoaderData() as CollectionPageResult;
  const search = Route.useSearch();
  const { state: session } = useSession();
  const sessionPage = useQuery({
    ...collectionPageQuery(
      initialPage.id,
      search.cursor,
      "session",
      search.filters,
    ),
    enabled:
      session === "signed-in" &&
      "visibility" in initialPage &&
      initialPage.visibility === null,
  });
  const page = sessionPage.data ?? initialPage;
  async function refreshPage() {
    const result = await readCollectionPage({
      data: {
        id: page.id,
        ...(search.cursor ? { cursor: search.cursor } : {}),
        credentialMode: "session",
        ...(search.filters ? { search: search.filters } : {}),
      },
    });
    if ("preparing" in result)
      throw new Error("Expected a curated collection page");
    return result;
  }
  return "preparing" in page ? (
    <DynamicCollectionPage
      page={page}
      readMembers={(id, cursor) =>
        readDynamicCollectionMembers({
          data: {
            id,
            ...(cursor ? { cursor } : {}),
            ...(search.filters ? { search: search.filters } : {}),
          },
        })
      }
    />
  ) : (
    <CollectionPage
      page={page}
      cursor={search.cursor}
      layout={search.layout ?? "list"}
      {...(search.filters ? { search: search.filters } : {})}
      queryKey={
        collectionPageQuery(page.id, search.cursor, "session", search.filters)
          .queryKey
      }
      refreshPage={refreshPage}
    />
  );
}
