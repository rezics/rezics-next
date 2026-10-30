import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useQuery } from '@tanstack/react-query';
import { RelationsView } from '../../features/pages/relations-view';
import { SubjectLink, viewTabLabels } from '../../features/pages/route-support';
import { SubjectFrame, subjectFrame } from '../../features/pages/subject-frame';
import { subjectPageType } from '../../features/pages/subject';
import { subjectTabs } from '../../features/pages/views';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime.js';
import {
  subjectCanonicalQuery,
  subjectFrameQuery,
  subjectLinksQuery,
  keepSearch,
  subjectPageQuery,
  subjectReaderQuery,
  subjectRelationsQuery,
  subjectUrlForView,
  subjectViewPaths,
} from '../../features/pages/subject-queries';
import { defaultReader } from '../../subject/reader';
import { m } from '../../paraglide/messages.js';
import { validateViewCursor } from '../../features/pages/view-cursor';
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
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) throw notFound();
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
      });

    return { paths: subjectViewPaths(canonical.value.paths, 'relations') };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/relations')({
  staticData: { publicCache: true },
  // Validate the cursor in the loader so invalid input answers the not-found document.
  validateSearch: (search: Record<string, unknown>): { property?: string; cursor?: unknown } => {
    return {
      ...(typeof search.property === 'string' && search.property.length <= 128 ? { property: search.property } : {}),
      cursor: search.cursor,
    };
  },
  loaderDeps: ({ search }) => ({ property: search.property, cursor: search.cursor }),
  loader: async ({ params, deps, location, context }) => {
    const cursor = validateViewCursor(deps.cursor);
    const canonical = await readRelations({
      data: {
        id: params.id,
        slug: params.slug,
        locale: getLocale(),
        property: deps.property,
        cursor,
        search: location.searchStr,
      },
    });
    const [overview, links] = await Promise.all([
      context.queryClient.ensureQueryData(subjectPageQuery(params.id, getLocale(), 'overview')),
      context.queryClient.ensureQueryData(subjectLinksQuery(params.id, getLocale(), deps.property, cursor)),
    ]);
    if (links.status === 400) throw notFound();
    if (overview.kind === 'redirect') {
      const survivor = await context.queryClient.ensureQueryData(subjectCanonicalQuery(overview.id, getLocale()));
      if (survivor.kind === 'missing') throw notFound();
      throw redirect({
        href: keepSearch(subjectUrlForView(survivor.value, 'relations'), location.searchStr),
        statusCode: 301,
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
      page: overview.page,
      title: frame.title.text,
      frame,
      tabs: subjectTabs(overview.page),
      type: typeData,
      relations,
      body,
      paths: canonical.paths,
      cursor,
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
  const { frame, tabs, type, relations, body } = Route.useLoaderData();
  const { state: session } = useSession();
  const { data: loadedReader } = useQuery({
    ...subjectReaderQuery(frame.id, getLocale()),
    enabled: session === 'signed-in',
  });
  const reader = loadedReader ?? defaultReader;
  const { property } = Route.useSearch();
  return (
    <RelationsView
      locale={getLocale()}
      subject={{ id: frame.id, label: frame.title.text }}
      frame={
        <SubjectFrame
          frame={frame}
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
      }
      data={{ body, property: property ?? null }}
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
