import { contextSubjectAddress } from '../../features/pages/context-subject';
import { PendingPage } from '../../shell/pending';
import { subjectReaderPartition, useSubjectReaderRefresh } from '../../features/pages/context-reader';
import { useSubjectPersonalReader } from '../../features/pages/subject-personal-reader';
import { isView, type View } from '@rezics/composition';
import { createFileRoute, notFound, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { subjectPageType } from '../../features/pages/subject';
import { SubjectFrame, subjectFrame, SubjectViewPage } from '../../features/pages/subject-frame';
import { SubjectLibraryLeaf } from '../../features/pages/subject-library-leaf';
import { subjectTabs } from '../../features/pages/views';
import {
  subjectCanonicalQuery,
  subjectRequestReader,
  subjectKernelClient,
  subjectPageQuery,
  subjectFrameQuery,
  canonicalRedirect,
  accountHref,
  keepSearch,
  subjectUrlForView,
  subjectViewPaths,
  subjectViewPagesQuery,
} from '../../features/pages/subject-queries';
import { useSession } from '../../session/query';
import { validateViewCursor, validatePageRealm, validatePageNode } from '../../features/pages/view-cursor';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { WriteReviewAction } from '../../subject/write-review';
import { subjectHead } from '../../features/pages/subject-head';
import { pageHeadContext } from '../../shell/head-context';
import { subjectRouteSearchLimit, subjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import { SubjectCandidateCuration } from '../../features/pages/curate-view';
import { SubjectViewError } from '../../subject/view-error';
import { env } from 'cloudflare:workers';

const viewLabel = {
  overview: () => m.subject_overview(),
  editions: () => m.subject_editions(),
  contents: () => m.subject_contents(),
  characters: () => m.subject_characters(),
  appearances: () => m.subject_appearances(),
  credits: () => m.subject_credits(),
  works: () => m.subject_works(),
  relations: () => m.subject_relations(),
  posts: () => m.subject_posts(),
  reviews: () => m.subject_reviews(),
  discussion: () => m.subject_discussion(),
  lists: () => m.subject_lists(),
  collections: () => m.subject_collections(),
  details: () => m.subject_details(),
} satisfies Record<View, () => string>;

const readView = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      !('slug' in input) ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      !('view' in input) ||
      !isView(input.view) ||
      !('locale' in input) ||
      typeof input.locale !== 'string' ||
      !('search' in input) ||
      typeof input.search !== 'string' ||
      input.search.length >
        subjectRouteSearchLimit(
          input.search,
          'cursor' in input && typeof input.cursor === 'string' ? input.cursor : undefined,
        )
    )
      throw notFound();
    const cursor = validateViewCursor('cursor' in input ? input.cursor : undefined);
    return {
      realm: validatePageRealm('realm' in input ? input.realm : undefined),
      reader: 'reader' in input && typeof input.reader === 'string' ? input.reader : null,
      id: input.id,
      slug: input.slug,
      view: input.view,
      locale: input.locale,
      search: input.search,
      cursor,
    };
  })
  .handler(async ({ data }) => {
    const config = env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SCRIPT_URL?: string };
    const verification = {
      sitekey: config.TURNSTILE_SITE_KEY ?? '',
      scriptUrl:
        (import.meta.env.DEV && config.TURNSTILE_SCRIPT_URL) ||
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    };
    if (data.realm)
      return {
        href: `/${data.locale}/subjects/${data.id}/${data.slug}`,
        paths: {} as Record<string, string>,
        verification,
      };
    const { loadContextSubject } = await import('../../features/pages/context-subject');
    const { client, authorization } = await subjectKernelClient(data.locale, data.realm, data.reader);
    const canonical = await loadContextSubject(client, data.id, data.locale, { realm: data.realm, authorization });
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug || canonical.value.href.includes('/@'))
      throw redirect(canonicalRedirect(subjectUrlForView(canonical.value, data.view), data.search));

    return {
      href: canonical.value.href,
      paths: subjectViewPaths(canonical.value.paths, data.view),
      verification,
    };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/$view')({
  staticData: { publicCache: false },
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  errorComponent: SubjectViewError,
  // Validate the cursor in the loader so invalid input answers the not-found document.
  validateSearch: (search: Record<string, unknown>) => ({
    cursor: search.cursor,
    realm: validatePageRealm(search.realm),
    node: validatePageNode(search.node),
    via: subjectVisitReturn(search.via, getLocale()),
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor, realm: search.realm, node: search.node, via: search.via }),
  loader: async ({ params, location, context, deps }) => {
    const reader = await subjectRequestReader({ data: { realm: deps.realm } });
    if (!isView(params.view) || params.view === 'overview') throw notFound();
    const cursor = validateViewCursor(deps.cursor);
    let canonical = await readView({
      data: {
        realm: deps.realm,
        reader,
        id: params.id,
        slug: params.slug,
        view: params.view,
        locale: getLocale(),
        search: keepSearch('', location.searchStr, location.hash),
        cursor,
      },
    });
    // Reuse the current native reading for the head, never a retained navigation result.
    const loaded = await context.queryClient.fetchQuery(
      subjectViewPagesQuery(params.id, getLocale(), params.view, cursor, deps.realm, deps.node, reader),
    );
    if (loaded.kind === 'missing') {
      const overview = await context.queryClient.fetchQuery(
        subjectPageQuery(params.id, getLocale(), 'overview', deps.realm, reader),
      );
      if (overview.kind !== 'page') throw notFound();
      throw redirect(canonicalRedirect(canonical.href, location.searchStr, location.hash, 302));
    }
    if (loaded.kind === 'redirect') {
      if (loaded.target === 'account')
        throw redirect({
          href: keepSearch(accountHref(getLocale(), loaded.id, params.view), location.searchStr, location.hash),
          statusCode: 301,
          headers: { 'Cache-Control': 'private, no-store' },
        });
      const survivor = await context.queryClient.fetchQuery(
        subjectCanonicalQuery(loaded.id, getLocale(), deps.realm, reader),
      );
      if (survivor.kind === 'missing') throw notFound();
      throw redirect({
        href: keepSearch(subjectUrlForView(survivor.value, params.view), location.searchStr, location.hash),
        statusCode: 301,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    if (deps.realm) {
      const address = contextSubjectAddress(loaded.overview, getLocale());
      if (address.slug !== params.slug)
        throw redirect(canonicalRedirect(subjectUrlForView(address, params.view), location.searchStr, location.hash));
      canonical = { ...canonical, href: address.href, paths: subjectViewPaths(address.paths, params.view) };
    }
    const frame = subjectFrame(loaded.overview, getLocale());
    if (!frame) throw notFound();
    const tabs = subjectTabs(loaded.overview);
    if (
      (loaded.overview.views !== undefined && !loaded.overview.views.includes(params.view)) ||
      ((params.view === 'reviews' || params.view === 'discussion') && !tabs.some((tab) => tab.view === params.view))
    ) {
      const survivor = await context.queryClient.fetchQuery(
        subjectCanonicalQuery(params.id, getLocale(), deps.realm, reader),
      );
      if (survivor.kind === 'missing') throw notFound();
      throw redirect(canonicalRedirect(subjectUrlForView(survivor.value), location.searchStr, location.hash, 302));
    }
    const type = subjectPageType(loaded.overview);
    const typeData = type ? await context.queryClient.ensureQueryData(subjectFrameQuery(type, getLocale())) : {};
    const nextHref =
      loaded.next !== undefined
        ? `${canonical.href}/${encodeURIComponent(params.view)}?${loaded.node ? `node=${encodeURIComponent(loaded.node)}&` : ''}cursor=${encodeURIComponent(loaded.next)}${deps.realm ? `&realm=${encodeURIComponent(deps.realm)}` : ''}${deps.via ? `&via=${encodeURIComponent(deps.via)}` : ''}`
        : undefined;
    return {
      ...canonical,
      reader,
      view: params.view,
      page: loaded.page,
      shareCard: loaded.shareCard,
      type: typeData,
      frame,
      tabs,
      title: frame.title.text,
      cursor,
      nextHref,
      realm: deps.realm,
      node: deps.node,
    };
  },
  head: ({ loaderData, match }) =>
    loaderData
      ? subjectHead(loaderData.page, {
          ...pageHeadContext(match.pathname),
          paths: loaderData.paths,
          shareCard: loaderData.shareCard,
          realm: loaderData.realm,
          ...(loaderData.type.label ? { typeLabel: loaderData.type.label } : {}),
          ...(loaderData.type.schemaOrgType ? { schemaOrgType: loaderData.type.schemaOrgType } : {}),
          view: loaderData.view,
          viewLabel: viewLabel[loaderData.view](),
          ...(loaderData.cursor === undefined ? {} : { cursor: loaderData.cursor }),
          includeJsonLd: false,
        })
      : { meta: [{ title: m.not_found_heading() }] },
  component: SubjectViewRoute,
});

function SubjectViewRoute() {
  const {
    type,
    frame,
    tabs,
    view,
    cursor,
    nextHref,
    realm,
    reader: initialReader,
    page,
    verification,
  } = Route.useLoaderData();
  const browserSession = useSession();
  const { state: session } = browserSession;
  const search = Route.useSearch();
  const readerKey = subjectReaderPartition(realm, initialReader, browserSession);
  const currentReader = useSubjectReaderRefresh(initialReader, readerKey);
  const personal = useSubjectPersonalReader({
    subjectId: page.subject!,
    locale: getLocale(),
    view,
    session: browserSession,
    enabled: currentReader,
  });
  const reader = personal.reader;
  const reviewSession = session === 'unknown' ? 'unavailable' : session;
  const currentHref = useLocation().publicHref;
  const nonce = useRouter().options.ssr?.nonce;
  const locale = getLocale();
  if (!currentReader) return <PendingPage />;
  return (
    <SubjectViewPage
      page={page}
      currentHref={currentHref}
      readingAdmission={JSON.stringify([browserSession.state, browserSession.subject, browserSession.csrfToken])}
      {...(search.via ? { returnTo: search.via } : {})}
      subjectLabel={frame.title.text}
      curation={
        view === 'details' && !realm ? <SubjectCandidateCuration id={page.subject!} locale={locale} /> : undefined
      }
      locale={locale}
      messages={subjectPageMessages()}
      {...(verification ? { verification } : {})}
      reader={reader}
      {...(type.label ? { typeLabel: type.label } : {})}
      {...(type.ratio ? { ratio: type.ratio } : {})}
      link={SubjectLink}
      view={view}
      label={viewLabel[view]()}
      {...(nextHref ? { nextHref } : {})}
      {...(view === 'reviews'
        ? {
            actions: (
              <WriteReviewAction
                subjectId={frame.id}
                subjectTitle={frame.title.text}
                session={reviewSession}
                locale={locale}
              />
            ),
          }
        : {})}
      frame={
        <SubjectFrame
          frame={frame}
          realm={realm}
          locale={locale}
          link={SubjectLink}
          reader={reader}
          coverLabels={{
            withheld: m.subject_cover_withheld(),
            reveal: m.subject_cover_reveal(),
            credit: m.subject_cover_credit(),
            via: m.subject_cover_via(),
          }}
          unlabelled={m.subject_value_unlabelled()}
          {...(type.label ? { typeLabel: type.label } : {})}
          {...(type.ratio ? { ratio: type.ratio } : {})}
          tabs={tabs}
          tabLabels={viewTabLabels()}
          view={view}
          {...(search.via ? { returnTo: search.via } : {})}
          library={<SubjectLibraryLeaf frame={frame} locale={locale} session={browserSession} />}
        />
      }
      {...(nonce !== undefined ? { nonce } : {})}
      renderJsonLd={false}
    />
  );
}
