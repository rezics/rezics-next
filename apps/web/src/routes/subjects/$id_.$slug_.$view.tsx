import { contextSubjectAddress } from '../../features/pages/context-subject';
import { PendingPage } from '../../shell/pending';
import { subjectReaderPartition, useSubjectReaderRefresh } from '../../features/pages/context-reader';
import { useSubjectPersonalReader } from '../../features/pages/subject-personal-reader';
import { isView, type PageContinuation, type View } from '@rezics/composition';
import { createFileRoute, notFound, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { pageRelationProperties, subjectPageType } from '../../features/pages/subject';
import { WorkFranchiseReading } from '../../features/pages/showcase-work';
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
  subjectRelationsQuery,
} from '../../features/pages/subject-queries';
import { useSession } from '../../session/query';
import { validateViewCursor, validatePageBoard, validatePageRealm, validatePageNode } from '../../features/pages/view-cursor';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { WriteReviewAction } from '../../subject/write-review';
import { subjectHead } from '../../features/pages/subject-head';
import { pageHeadContext } from '../../shell/head-context';
import { subjectRouteSearchLimit, subjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import { SubjectCandidateCuration } from '../../features/pages/curate-view';
import { SubjectViewError } from '../../subject/view-error';
import { env } from 'cloudflare:workers';
import { awaitSubjectRoute, readSubjectCanonicalQuery } from '../../features/pages/subject-canonical-lifetime';

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
    const signal = getRequest().signal;
    signal.throwIfAborted();
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
    const { client, authorization } = await subjectKernelClient(data.locale, data.realm, data.reader, signal);
    signal.throwIfAborted();
    const canonical = await loadContextSubject(client, data.id, data.locale, {
      realm: data.realm,
      authorization,
      signal,
    });
    signal.throwIfAborted();
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
  validateSearch: (search: Record<string, unknown>) => {
    const node = validatePageNode(search.node);
    const streamProperty = search.streamProperty;
    const streamDirection = search.streamDirection;
    const validatedStreamDirection: 'forward' | 'inverse' | undefined =
      streamDirection === 'forward' || streamDirection === 'inverse' ? streamDirection : undefined;
    if (
      (search.cursor !== undefined && node === undefined) ||
      (streamProperty !== undefined &&
        (typeof streamProperty !== 'string' ||
          !streamProperty.trim() ||
          streamProperty.length > 256 ||
          /[\u0000-\u001f\u007f]/u.test(streamProperty))) ||
      (streamDirection !== undefined && streamDirection !== 'forward' && streamDirection !== 'inverse') ||
      ((streamProperty !== undefined || streamDirection !== undefined) &&
        (node === undefined || streamProperty === undefined || streamDirection === undefined))
    )
      throw notFound();
    return {
      cursor: search.cursor,
      realm: validatePageRealm(search.realm),
      board: validatePageBoard(search.board),
      node,
      ...(typeof streamProperty === 'string' ? { streamProperty } : {}),
      ...(validatedStreamDirection ? { streamDirection: validatedStreamDirection } : {}),
      via: subjectVisitReturn(search.via, getLocale()),
    };
  },
  loaderDeps: ({ search }) => ({
    cursor: search.cursor,
    realm: search.realm,
    board: search.board,
    node: search.node,
    streamProperty: search.streamProperty,
    streamDirection: search.streamDirection,
    via: search.via,
  }),
  loader: async ({ params, location, context, deps, abortController }) => {
    const signal = abortController.signal;
    const reader = await awaitSubjectRoute(signal, () => subjectRequestReader({ data: { realm: deps.realm }, signal }));
    if (!isView(params.view) || params.view === 'overview') throw notFound();
    const view = params.view as View;
    const cursor = validateViewCursor(deps.cursor);
    let canonical = await awaitSubjectRoute(signal, () =>
      readView({
        data: {
          realm: deps.realm,
          reader,
          id: params.id,
          slug: params.slug,
          view,
          locale: getLocale(),
          search: keepSearch('', location.searchStr, location.hash),
          cursor,
        },
        signal,
      }),
    );
    // Reuse the current native reading for the head, never a retained navigation result.
    const loaded = await awaitSubjectRoute(signal, () =>
      context.queryClient.fetchQuery(
        subjectViewPagesQuery(params.id, getLocale(), view, cursor, deps.realm, deps.node, reader, deps.board),
      ),
    );
    signal.throwIfAborted();
    if (loaded.kind === 'missing') {
      const overview = await awaitSubjectRoute(signal, () =>
        context.queryClient.fetchQuery(
          subjectPageQuery(params.id, getLocale(), 'overview', deps.realm, reader, deps.board),
        ),
      );
      if (overview.kind !== 'page') throw notFound();
      throw redirect(canonicalRedirect(canonical.href, location.searchStr, location.hash, 302));
    }
    if (loaded.kind === 'redirect') {
      if (loaded.target === 'account')
        throw redirect({
          href: keepSearch(accountHref(getLocale(), loaded.id, view), location.searchStr, location.hash),
          statusCode: 301,
          headers: { 'Cache-Control': 'private, no-store' },
        });
      const survivor = await readSubjectCanonicalQuery(
        context.queryClient,
        subjectCanonicalQuery(loaded.id, getLocale(), deps.realm, reader),
        signal,
      );
      if (survivor.kind === 'missing') throw notFound();
      throw redirect({
        href: keepSearch(subjectUrlForView(survivor.value, view), location.searchStr, location.hash),
        statusCode: 301,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    if (deps.realm) {
      const address = contextSubjectAddress(loaded.overview, getLocale());
      if (address.slug !== params.slug)
        throw redirect(canonicalRedirect(subjectUrlForView(address, view), location.searchStr, location.hash));
      canonical = { ...canonical, href: address.href, paths: subjectViewPaths(address.paths, view) };
    }
    const frame = subjectFrame(loaded.overview, getLocale());
    if (!frame) throw notFound();
    const tabs = subjectTabs(loaded.overview);
    if (
      (loaded.overview.views !== undefined && !loaded.overview.views.includes(view)) ||
      ((view === 'reviews' || view === 'discussion') && !tabs.some((tab) => tab.view === view))
    ) {
      const survivor = await readSubjectCanonicalQuery(
        context.queryClient,
        subjectCanonicalQuery(params.id, getLocale(), deps.realm, reader),
        signal,
      );
      if (survivor.kind === 'missing') throw notFound();
      throw redirect(canonicalRedirect(subjectUrlForView(survivor.value), location.searchStr, location.hash, 302));
    }
    const type = subjectPageType(loaded.overview);
    const [typeData, relations] = await awaitSubjectRoute(signal, () =>
      Promise.all([
        type ? context.queryClient.ensureQueryData(subjectFrameQuery(type, getLocale())) : Promise.resolve({}),
        deps.streamProperty
          ? context.queryClient.ensureQueryData(subjectRelationsQuery(pageRelationProperties(loaded.page), getLocale()))
          : Promise.resolve(undefined),
      ]),
    );
    const nextHref =
      loaded.next !== undefined
        ? `${canonical.href}/${encodeURIComponent(view)}?${new URLSearchParams({
            ...(loaded.node ? { node: loaded.node } : {}),
            cursor: loaded.next,
            ...(deps.realm ? { realm: deps.realm } : {}),
            ...(deps.streamProperty ? { streamProperty: deps.streamProperty } : {}),
            ...(deps.streamDirection ? { streamDirection: deps.streamDirection } : {}),
            ...(deps.via ? { via: deps.via } : {}),
          })}`
        : undefined;
    return {
      ...canonical,
      reader,
      view,
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
      streamProperty: deps.streamProperty,
      streamDirection: deps.streamDirection,
      relations,
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
    node,
    streamProperty,
    streamDirection,
    relations,
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
  const navigate = Route.useNavigate();
  const nonce = useRouter().options.ssr?.nonce;
  const locale = getLocale();
  const onWorkContinue = (continuation: PageContinuation) => {
    void navigate({
      search: (previous) => ({ ...previous, node: continuation.node, cursor: continuation.cursor }),
      hash: '#work-franchise',
      resetScroll: false,
    });
  };
  if (!currentReader) return <PendingPage />;
  return (
    <SubjectViewPage
      page={page}
      currentHref={currentHref}
      readingAdmission={JSON.stringify([browserSession.state, browserSession.subject, browserSession.csrfToken])}
      selectedNode={node}
      selectedStreamProperty={streamProperty}
      selectedStreamDirection={streamDirection}
      selectedCursor={cursor}
      onWorkContinue={onWorkContinue}
      finiteWorkRegionReader={WorkFranchiseReading}
      {...(relations ? { relations } : {})}
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
                returnTo={currentHref}
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
