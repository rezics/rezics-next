import { contextSubjectAddress } from '../../features/pages/context-subject';
import { PendingPage } from '../../shell/pending';
import { subjectReaderPartition, useSubjectReaderRefresh } from '../../features/pages/context-reader';
import { useSubjectPersonalReader } from '../../features/pages/subject-personal-reader';
import { createFileRoute, notFound, redirect, useLocation } from '@tanstack/react-router';
import type { PageContinuation } from '@rezics/composition';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { RelationsView } from '../../features/pages/relations-view';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { SubjectFrame, SubjectViewPage } from '../../features/pages/subject-frame';
import { subjectFrame } from '../../features/pages/subject-frame-model';
import { WorkFranchiseReading } from '../../features/pages/showcase-work';
import { SubjectLibraryLeaf } from '../../features/pages/subject-library-leaf';
import { pageRelationProperties, subjectPageType } from '../../features/pages/subject-page-summary';
import { subjectTabs } from '../../features/pages/views';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime.js';
import {
  subjectCanonicalQuery,
  subjectRequestReader,
  subjectKernelClient,
  subjectFrameQuery,
  subjectLinksQuery,
  canonicalRedirect,
  accountHref,
  keepSearch,
  subjectPageQuery,
  subjectRelationsQuery,
  subjectUrlForView,
  subjectViewPaths,
  subjectViewPagesQuery,
} from '../../features/pages/subject-queries';
import { m } from '../../paraglide/messages.js';
import { validateViewCursor, validatePageRealm, validatePageNode } from '../../features/pages/view-cursor';
import { subjectHead } from '../../features/pages/subject-head';
import { pageHeadContext } from '../../shell/head-context';
import { subjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import { awaitSubjectRoute, readSubjectCanonicalQuery } from '../../features/pages/subject-canonical-lifetime';

const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const curiePattern = /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_.-]+$/;

const readRelations = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const { id, slug, locale, property, cursor, search } = record;
    if (
      typeof id !== 'string' ||
      !subjectIdPattern.test(id) ||
      typeof slug !== 'string' ||
      slug.length > 128 ||
      typeof locale !== 'string' ||
      locale.length > 35 ||
      typeof search !== 'string' ||
      search.length > 2048 + (typeof cursor === 'string' ? encodeURIComponent(cursor).length : 0)
    )
      throw notFound();
    if (
      property !== undefined &&
      (typeof property !== 'string' || !curiePattern.test(property) || property.length > 128)
    )
      throw notFound();
    validateViewCursor(cursor);
    return {
      realm: validatePageRealm(record.realm),
      reader: typeof record.reader === 'string' ? record.reader : null,
      id,
      slug,
      locale,
      search,
      property: property as string | undefined,
      cursor: cursor as string | undefined,
    };
  })
  .handler(async ({ data }) => {
    const signal = getRequest().signal;
    signal.throwIfAborted();
    if (data.realm)
      return { href: `/${data.locale}/subjects/${data.id}/${data.slug}`, paths: {} as Record<string, string> };
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
      throw redirect({
        href: keepSearch(subjectUrlForView(canonical.value, 'relations'), data.search),
        statusCode: 301,
        headers: { 'Cache-Control': 'private, no-store' },
      });

    return { href: canonical.value.href, paths: subjectViewPaths(canonical.value.paths, 'relations') };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/relations')({
  staticData: { publicCache: false },
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  // Validate the cursor in the loader so invalid input answers the not-found document.
  validateSearch: (search: Record<string, unknown>) => {
    const node = validatePageNode(search.node);
    const streamProperty = search.streamProperty;
    const streamDirection = search.streamDirection;
    const validatedStreamDirection: 'forward' | 'inverse' | undefined =
      streamDirection === 'forward' || streamDirection === 'inverse' ? streamDirection : undefined;
    if (
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
      ...(typeof search.property === 'string' && search.property.length <= 128 ? { property: search.property } : {}),
      cursor: search.cursor,
      realm: validatePageRealm(search.realm),
      node,
      ...(typeof streamProperty === 'string' ? { streamProperty } : {}),
      ...(validatedStreamDirection ? { streamDirection: validatedStreamDirection } : {}),
      via: subjectVisitReturn(search.via, getLocale()),
    };
  },
  loaderDeps: ({ search }) => ({
    property: search.property,
    cursor: search.cursor,
    realm: search.realm,
    node: search.node,
    streamProperty: search.streamProperty,
    streamDirection: search.streamDirection,
    via: search.via,
  }),
  loader: async ({ params, deps, location, context, abortController }) => {
    const signal = abortController.signal;
    const reader = await awaitSubjectRoute(signal, () => subjectRequestReader({ data: { realm: deps.realm }, signal }));
    const cursor = validateViewCursor(deps.cursor);
    let canonical = await awaitSubjectRoute(signal, () =>
      readRelations({
        data: {
          realm: deps.realm,
          reader,
          id: params.id,
          slug: params.slug,
          locale: getLocale(),
          property: deps.property,
          cursor,
          search: keepSearch('', location.searchStr, location.hash),
        },
        signal,
      }),
    );
    // Configured groups use their native incoming/outgoing descriptors and independent signed continuations.
    // Keep the older Global property-only URL for callers whose profile has no corresponding view node.
    if (!deps.property || deps.realm || deps.node) {
      const loaded = await awaitSubjectRoute(signal, () =>
        context.queryClient.fetchQuery(
          subjectViewPagesQuery(params.id, getLocale(), 'relations', cursor, deps.realm, deps.node, reader),
        ),
      );
      signal.throwIfAborted();
      if (loaded.kind === 'redirect') {
        if (loaded.target === 'account')
          throw redirect(
            canonicalRedirect(accountHref(getLocale(), loaded.id, 'relations'), location.searchStr, location.hash),
          );
        const survivor = await readSubjectCanonicalQuery(
          context.queryClient,
          subjectCanonicalQuery(loaded.id, getLocale(), deps.realm, reader),
          signal,
        );
        if (survivor.kind === 'missing') throw notFound();
        throw redirect(
          canonicalRedirect(subjectUrlForView(survivor.value, 'relations'), location.searchStr, location.hash),
        );
      }
      if (loaded.kind !== 'page') throw notFound();
      if (deps.realm) {
        const address = contextSubjectAddress(loaded.overview, getLocale());
        if (address.slug !== params.slug)
          throw redirect(canonicalRedirect(subjectUrlForView(address, 'relations'), location.searchStr, location.hash));
        canonical = { href: address.href, paths: subjectViewPaths(address.paths, 'relations') };
      }
      const frame = subjectFrame(loaded.overview, getLocale());
      if (!frame) throw notFound();
      const type = subjectPageType(loaded.overview);
      const [typeData, relations] = await awaitSubjectRoute(signal, () =>
        Promise.all([
          context.queryClient.ensureQueryData(subjectFrameQuery(type ?? '', getLocale())),
          context.queryClient.ensureQueryData(subjectRelationsQuery(pageRelationProperties(loaded.page), getLocale())),
        ]),
      );
      return {
        configured: true as const,
        reader,
        page: loaded.page,
        title: frame.title.text,
        frame,
        tabs: subjectTabs(loaded.overview),
        type: typeData,
        relations,
        paths: canonical.paths,
        cursor,
        realm: deps.realm,
        via: deps.via,
        node: deps.node,
        streamProperty: deps.streamProperty,
        streamDirection: deps.streamDirection,
      };
    }
    const [overview, links] = await awaitSubjectRoute(signal, () =>
      Promise.all([
        context.queryClient.fetchQuery(subjectPageQuery(params.id, getLocale(), 'overview')),
        context.queryClient.ensureQueryData(subjectLinksQuery(params.id, getLocale(), deps.property, cursor)),
      ]),
    );
    signal.throwIfAborted();
    if (links.status === 400) throw notFound();
    if (overview.kind === 'redirect') {
      if (overview.target === 'account')
        throw redirect(
          canonicalRedirect(accountHref(getLocale(), overview.id, 'relations'), location.searchStr, location.hash),
        );
      const survivor = await readSubjectCanonicalQuery(
        context.queryClient,
        subjectCanonicalQuery(overview.id, getLocale()),
        signal,
      );
      if (survivor.kind === 'missing') throw notFound();
      throw redirect({
        href: keepSearch(subjectUrlForView(survivor.value, 'relations'), location.searchStr, location.hash),
        statusCode: 301,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    if (overview.kind !== 'page') throw notFound();
    const frame = subjectFrame(overview.page, getLocale());
    if (!frame) throw notFound();
    const type = subjectPageType(overview.page);
    const body: Record<string, unknown> = links.status === 200 ? (links.body as Record<string, unknown>) : {};
    const properties = new Set<string>(deps.property ? [deps.property] : []);
    if (Array.isArray(body.links))
      for (const link of body.links) if (typeof link?.property === 'string') properties.add(link.property);
    const [typeData, relations] = await awaitSubjectRoute(signal, () =>
      Promise.all([
        type
          ? context.queryClient.ensureQueryData(subjectFrameQuery(type, getLocale()))
          : Promise.resolve({ label: undefined, ratio: undefined, schemaOrgType: undefined }),
        context.queryClient.ensureQueryData(subjectRelationsQuery([...properties], getLocale())),
      ]),
    );
    return {
      configured: false as const,
      reader,
      page: overview.page,
      title: frame.title.text,
      frame,
      tabs: subjectTabs(overview.page),
      type: typeData,
      relations,
      body,
      paths: canonical.paths,
      cursor,
      realm: undefined,
      via: deps.via,
    };
  },
  head: ({ loaderData, match }) =>
    loaderData
      ? subjectHead(loaderData.page, {
          ...pageHeadContext(match.pathname),
          paths: loaderData.paths,
          ...(loaderData.type.label ? { typeLabel: loaderData.type.label } : {}),
          ...(loaderData.type.schemaOrgType ? { schemaOrgType: loaderData.type.schemaOrgType } : {}),
          view: 'relations',
          viewLabel: m.subject_relations(),
          ...(loaderData.cursor === undefined ? {} : { cursor: loaderData.cursor }),
          includeJsonLd: false,
        })
      : { meta: [{ title: m.not_found_heading() }] },
  component: RelationsRoute,
});

function RelationsRoute() {
  const coverLabels = {
    withheld: m.subject_cover_withheld(),
    reveal: m.subject_cover_reveal(),
    credit: m.subject_cover_credit(),
    via: m.subject_cover_via(),
  };
  const data = Route.useLoaderData();
  const { frame, tabs, type, relations, realm } = data;
  const currentHref = useLocation().publicHref;
  const navigate = Route.useNavigate();
  const browserSession = useSession();
  const { state: session } = browserSession;
  const readerKey = subjectReaderPartition(realm, data.reader, browserSession);
  const currentReader = useSubjectReaderRefresh(data.reader, readerKey);
  const personal = useSubjectPersonalReader({
    subjectId: frame.id,
    locale: getLocale(),
    view: 'relations',
    session: browserSession,
    enabled: currentReader,
  });
  const reader = personal.reader;
  const { property } = Route.useSearch();
  const onWorkContinue = (continuation: PageContinuation) => {
    void navigate({
      search: (previous) => ({ ...previous, node: continuation.node, cursor: continuation.cursor }),
      hash: '#work-franchise',
      resetScroll: false,
    });
  };
  if (!currentReader) return <PendingPage />;
  const frameElement = (
    <SubjectFrame
      frame={frame}
      realm={realm}
      locale={getLocale()}
      link={SubjectLink}
      reader={reader}
      coverLabels={coverLabels}
      unlabelled={m.subject_value_unlabelled()}
      {...(type.label ? { typeLabel: type.label } : {})}
      {...(type.ratio ? { ratio: type.ratio } : {})}
      tabs={tabs}
      tabLabels={viewTabLabels()}
      view="relations"
      {...(data.via ? { returnTo: data.via } : {})}
      library={<SubjectLibraryLeaf frame={frame} locale={getLocale()} session={browserSession} />}
    />
  );
  if (data.configured)
    return (
      <SubjectViewPage
        page={data.page}
        {...(data.via ? { returnTo: data.via } : {})}
        currentHref={currentHref}
        selectedNode={data.configured ? data.node : undefined}
        selectedStreamProperty={data.configured ? data.streamProperty : undefined}
        selectedStreamDirection={data.configured ? data.streamDirection : undefined}
        selectedCursor={data.cursor}
        onWorkContinue={onWorkContinue}
        finiteWorkRegionReader={WorkFranchiseReading}
        subjectLabel={frame.title.text}
        locale={getLocale()}
        messages={subjectPageMessages()}
        reader={reader}
        link={SubjectLink}
        view="relations"
        label={m.subject_relations()}
        relations={relations}
        frame={frameElement}
        renderJsonLd={false}
      />
    );
  return (
    <RelationsView
      locale={getLocale()}
      subject={{ id: frame.id, label: frame.title.text }}
      frame={frameElement}
      data={{ body: data.body, property: property ?? null }}
      relations={relations}
      value={{
        locale: getLocale(),
        link: SubjectLink,
        reader,
        unlabelled: m.subject_value_unlabelled(),
        spoilerShow: m.subject_spoiler_show(),
        labels: {
          spoilerShow: m.subject_spoiler_show(),
          documentSpoiler: m.thread_reveal_spoiler(),
          cover: coverLabels,
        },
      }}
    />
  );
}
