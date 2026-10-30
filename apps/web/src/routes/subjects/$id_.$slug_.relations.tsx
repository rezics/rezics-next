import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useQuery } from '@tanstack/react-query';
import { RelationsView } from '../../features/pages/relations-view';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { SubjectFrame, subjectFrame, SubjectViewPage } from '../../features/pages/subject-frame';
import { pageRelationProperties, subjectPageType } from '../../features/pages/subject';
import { subjectTabs } from '../../features/pages/views';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime.js';
import {
  subjectCanonicalQuery,
  subjectFrameQuery,
  subjectLinksQuery,
  canonicalRedirect,
  accountHref,
  keepSearch,
  subjectPageQuery,
  subjectReaderQuery,
  subjectRelationsQuery,
  subjectUrlForView,
  subjectViewPaths,
  subjectViewPagesQuery,
} from '../../features/pages/subject-queries';
import { defaultReader } from '../../subject/reader';
import { m } from '../../paraglide/messages.js';
import { validateViewCursor, validatePageRealm, validatePageNode } from '../../features/pages/view-cursor';
import { subjectHead } from '../../features/pages/subject-head';
import { pageHeadContext } from '../../shell/head-context';

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
      id,
      slug,
      locale,
      search,
      property: property as string | undefined,
      cursor: cursor as string | undefined,
    };
  })
  .handler(async ({ data }) => {
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    const canonical = await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug || canonical.value.href.includes('/@'))
      throw redirect({
        href: keepSearch(subjectUrlForView(canonical.value, 'relations'), data.search),
        statusCode: 301,
        headers: { 'Cache-Control': 'private, no-store' },
      });

    return { paths: subjectViewPaths(canonical.value.paths, 'relations') };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/relations')({
  staticData: { publicCache: false },
  // Validate the cursor in the loader so invalid input answers the not-found document.
  validateSearch: (search: Record<string, unknown>) => {
    return {
      ...(typeof search.property === 'string' && search.property.length <= 128 ? { property: search.property } : {}),
      cursor: search.cursor,
      realm: validatePageRealm(search.realm),
      node: validatePageNode(search.node),
    };
  },
  loaderDeps: ({ search }) => ({
    property: search.property,
    cursor: search.cursor,
    realm: search.realm,
    node: search.node,
  }),
  loader: async ({ params, deps, location, context }) => {
    const cursor = validateViewCursor(deps.cursor);
    const canonical = await readRelations({
      data: {
        id: params.id,
        slug: params.slug,
        locale: getLocale(),
        property: deps.property,
        cursor,
        search: keepSearch('', location.searchStr, location.hash),
      },
    });
    // Configured groups use their native incoming/outgoing descriptors and independent signed continuations.
    // Keep the older Global property-only URL for callers whose profile has no corresponding view node.
    if (!deps.property || deps.realm || deps.node) {
      const loaded = await context.queryClient.ensureQueryData(
        subjectViewPagesQuery(params.id, getLocale(), 'relations', cursor, deps.realm, deps.node),
      );
      if (loaded.kind === 'redirect') {
        if (loaded.target === 'account')
          throw redirect(
            canonicalRedirect(accountHref(getLocale(), loaded.id, 'relations'), location.searchStr, location.hash),
          );
        const survivor = await context.queryClient.ensureQueryData(subjectCanonicalQuery(loaded.id, getLocale()));
        if (survivor.kind === 'missing') throw notFound();
        throw redirect(
          canonicalRedirect(subjectUrlForView(survivor.value, 'relations'), location.searchStr, location.hash),
        );
      }
      if (loaded.kind !== 'page') throw notFound();
      const frame = subjectFrame(loaded.overview, getLocale());
      if (!frame) throw notFound();
      const type = subjectPageType(loaded.overview);
      const [typeData, relations] = await Promise.all([
        context.queryClient.ensureQueryData(subjectFrameQuery(type ?? '', getLocale())),
        context.queryClient.ensureQueryData(subjectRelationsQuery(pageRelationProperties(loaded.page), getLocale())),
      ]);
      return {
        configured: true as const,
        page: loaded.page,
        title: frame.title.text,
        frame,
        tabs: subjectTabs(loaded.overview),
        type: typeData,
        relations,
        paths: canonical.paths,
        cursor,
        realm: deps.realm,
      };
    }
    const [overview, links] = await Promise.all([
      context.queryClient.ensureQueryData(subjectPageQuery(params.id, getLocale(), 'overview')),
      context.queryClient.ensureQueryData(subjectLinksQuery(params.id, getLocale(), deps.property, cursor)),
    ]);
    if (links.status === 400) throw notFound();
    if (overview.kind === 'redirect') {
      if (overview.target === 'account')
        throw redirect(
          canonicalRedirect(accountHref(getLocale(), overview.id, 'relations'), location.searchStr, location.hash),
        );
      const survivor = await context.queryClient.ensureQueryData(subjectCanonicalQuery(overview.id, getLocale()));
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
    const [typeData, relations] = await Promise.all([
      type
        ? context.queryClient.ensureQueryData(subjectFrameQuery(type, getLocale()))
        : Promise.resolve({ label: undefined, ratio: undefined, schemaOrgType: undefined }),
      context.queryClient.ensureQueryData(subjectRelationsQuery([...properties], getLocale())),
    ]);
    return {
      configured: false as const,
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
  const { state: session } = useSession();
  const { data: loadedReader } = useQuery({
    ...subjectReaderQuery(frame.id, getLocale()),
    enabled: session === 'signed-in',
  });
  const reader = loadedReader ?? defaultReader;
  const { property } = Route.useSearch();
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
    />
  );
  if (data.configured)
    return (
      <SubjectViewPage
        page={data.page}
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
