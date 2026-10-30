import { createFileRoute, isNotFound } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as v from 'valibot';
import { CollectionPage, collectionPageHead } from '../../library/collection-page';
import { DynamicCollectionPage } from '../../library/dynamic-collection-page';
import { collectionRenderPolicy, type CollectionPageResult } from '../../library/collection-load';
import {
  collectionPageQuery,
  readCollectionPage,
  readDynamicCollectionMembers,
} from '../../library/collection-queries';
import { libraryTitleValue } from '../../library/title';
import { pageText } from '../../features/pages/shared';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { pageHead, pageLinks } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { useSession } from '../../session/query';
import { CollectionAccessState } from '../../library/collection-access';

export const Route = createFileRoute('/collections/$id')({
  staticData: { publicCache: true },
  validateSearch: (search: Record<string, unknown>) => {
    const { cursor } = v.parse(
      v.object({
        cursor: v.fallback(v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))), undefined),
      }),
      search,
    );
    const filters: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(search))
      if (key === 'type' && typeof value === 'string' && value.length <= 128) filters[key] = value;
      else if (
        /^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) &&
        (typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))
      )
        filters[key] = value as string | string[];
    const layout: 'grid' | 'list' | undefined =
      search.layout === 'grid' || search.layout === 'list' ? search.layout : undefined;
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
    return context.queryClient.ensureQueryData(collectionPageQuery(params.id, deps.cursor, 'anonymous', deps.filters));
  },
  head: ({ loaderData, match }) => {
    if (!loaderData)
      return pageHead({ title: m.not_found_heading(), robots: 'noindex, follow' }, pageHeadContext(match.pathname));
    const context = pageHeadContext(match.pathname);
    const base = collectionPageHead(loaderData, context, loaderData.cursor !== undefined);
    const title = pageText(libraryTitleValue(loaderData.title), context.locale).text;
    const canonical = pageLinks(context.origin, context.locale, context.path)[0]!.href;
    const itemList =
      !('preparing' in loaderData) && collectionRenderPolicy(loaderData).completeItemList
        ? {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            name: title,
            ...(loaderData.description ? { description: loaderData.description } : {}),
            url: canonical,
            itemListOrder: 'https://schema.org/ItemListOrderAscending',
            numberOfItems: loaderData.members.filter((member) => member.subject != null).length,
            itemListElement: loaderData.members
              .filter((member) => member.subject != null)
              .map((member, index) => {
                const subject = member.subject!;
                const label = pageText(libraryTitleValue(subject.label), context.locale).text;
                const itemPath = subjectHref({ id: subject.id, label }, context.locale).href;
                return {
                  '@type': 'ListItem',
                  position: index + 1,
                  item: {
                    '@id': new URL(itemPath, context.origin).href,
                    name: label,
                  },
                  ...(member.note ? { description: member.note } : {}),
                };
              }),
          }
        : undefined;
    const scripts = itemList === undefined ? [] : pageHead({ title, jsonLd: itemList }, context).scripts;
    return { ...base, scripts };
  },
  component: CollectionRoute,
  notFoundComponent: PrivateCollectionRoute,
});

function CollectionRoute() {
  const initialPage = Route.useLoaderData();
  return <CollectionContent initialPage={initialPage} />;
}

/** Concealed public 404s can recover an authorized private Collection after hydration. */
function PrivateCollectionRoute() {
  return <CollectionContent />;
}

function CollectionContent({ initialPage }: { initialPage?: CollectionPageResult }) {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const { state: session } = useSession();
  const sessionPage = useQuery({
    ...collectionPageQuery(id, search.cursor, 'session', search.filters),
    enabled: session === 'signed-in',
    retry: false,
  });
  if (!initialPage && !sessionPage.data) {
    const state =
      sessionPage.error && !isNotFound(sessionPage.error)
        ? 'unavailable'
        : session === 'unknown' || (session === 'signed-in' && sessionPage.isPending)
          ? 'loading'
          : 'not-found';
    return <CollectionAccessState state={state} />;
  }
  const page = session === 'signed-in' ? (sessionPage.data ?? initialPage) : initialPage;
  if (!page) return <CollectionAccessState state="not-found" />;
  if (session === 'signed-in' && sessionPage.error)
    return <CollectionAccessState state={isNotFound(sessionPage.error) ? 'not-found' : 'unavailable'} />;
  async function refreshPage(editor = false) {
    const result = await readCollectionPage({
      data: {
        id,
        ...(editor ? { editor: true } : {}),
        ...(search.cursor ? { cursor: search.cursor } : {}),
        credentialMode: 'session',
        ...(search.filters ? { search: search.filters } : {}),
      },
    });
    if ('preparing' in result) throw new Error('Expected a curated collection page');
    return result;
  }
  return 'preparing' in page ? (
    <DynamicCollectionPage
      page={page}
      {...(search.filters ? { search: search.filters } : {})}
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
      layout={search.layout ?? 'list'}
      {...(search.filters ? { search: search.filters } : {})}
      queryKey={collectionPageQuery(page.id, search.cursor, 'session', search.filters).queryKey}
      refreshPage={() => refreshPage()}
      readEditorPage={() => refreshPage(true)}
    />
  );
}
