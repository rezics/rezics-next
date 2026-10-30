import { isView, type View } from '@rezics/composition';
import { createFileRoute, notFound, redirect, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { subjectPageType } from '../../features/pages/subject';
import { SubjectFrame, subjectFrame, SubjectViewPage } from '../../features/pages/subject-frame';
import { subjectTabs } from '../../features/pages/views';
import {
  subjectCanonicalQuery,
  subjectFrameQuery,
  keepSearch,
  subjectReaderQuery,
  subjectUrlForView,
  subjectViewPaths,
  subjectViewPagesQuery,
} from '../../features/pages/subject-queries';
import { useSession } from '../../session/query';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { defaultReader } from '../../subject/reader';
import { validateViewCursor } from '../../features/pages/view-cursor';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { WriteReviewAction } from '../../subject/write-review';

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
        2048 + ('cursor' in input && typeof input.cursor === 'string' ? encodeURIComponent(input.cursor).length : 0)
    )
      throw notFound();
    const cursor = validateViewCursor('cursor' in input ? input.cursor : undefined);
    return { id: input.id, slug: input.slug, view: input.view, locale: input.locale, search: input.search, cursor };
  })
  .handler(async ({ data }) => {
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    const client = kernelClient(data.locale);
    const canonical = await loadSubject(client, data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug || canonical.value.href.includes('/@'))
      throw redirect({ href: keepSearch(subjectUrlForView(canonical.value, data.view), data.search), statusCode: 301 });

    return { href: canonical.value.href, paths: subjectViewPaths(canonical.value.paths, data.view) };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/$view')({
  // Validate the cursor in the loader so invalid input answers the not-found document.
  validateSearch: (search: Record<string, unknown>): { cursor?: unknown } => ({ cursor: search.cursor }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: async ({ params, location, context, deps }) => {
    if (!isView(params.view) || params.view === 'overview') throw notFound();
    const cursor = validateViewCursor(deps.cursor);
    const canonical = await readView({
      data: {
        id: params.id,
        slug: params.slug,
        view: params.view,
        locale: getLocale(),
        search: location.searchStr,
        cursor,
      },
    });
    const loaded = await context.queryClient.ensureQueryData(
      subjectViewPagesQuery(params.id, getLocale(), params.view, cursor),
    );
    if (loaded.kind === 'missing') throw notFound();
    if (loaded.kind === 'redirect') {
      if (loaded.target === 'account')
        throw redirect({
          href: keepSearch(
            `/${encodeURIComponent(getLocale())}/@${encodeURIComponent(loaded.id)}/${params.view}`,
            location.searchStr,
          ),
          statusCode: 308,
        });
      const survivor = await context.queryClient.ensureQueryData(subjectCanonicalQuery(loaded.id, getLocale()));
      if (survivor.kind === 'missing') throw notFound();
      throw redirect({
        href: keepSearch(subjectUrlForView(survivor.value, params.view), location.searchStr),
        statusCode: 301,
      });
    }
    const frame = subjectFrame(loaded.overview, getLocale());
    if (!frame) throw notFound();
    const tabs = subjectTabs(loaded.overview);
    if ((params.view === 'reviews' || params.view === 'discussion') && !tabs.some((tab) => tab.view === params.view)) {
      const survivor = await context.queryClient.ensureQueryData(subjectCanonicalQuery(params.id, getLocale()));
      if (survivor.kind === 'missing') throw notFound();
      throw redirect({ href: keepSearch(subjectUrlForView(survivor.value), location.searchStr), statusCode: 302 });
    }
    const type = subjectPageType(loaded.overview);
    const typeData = type ? await context.queryClient.ensureQueryData(subjectFrameQuery(type, getLocale())) : {};
    const nextHref =
      loaded.next !== undefined
        ? `${canonical.href}/${encodeURIComponent(params.view)}?cursor=${encodeURIComponent(loaded.next)}`
        : undefined;
    return {
      ...canonical,
      view: params.view,
      page: loaded.page,
      type: typeData,
      frame,
      tabs,
      title: frame.title.text,
      cursor,
      nextHref,
    };
  },
  head: ({ loaderData }) => ({
    meta: [
      ...(loaderData?.cursor !== undefined ? [{ name: 'robots', content: 'noindex, follow' }] : []),
      {
        title: loaderData
          ? [loaderData.title, viewLabel[loaderData.view]()].filter(Boolean).join(' · ')
          : m.not_found_heading(),
      },
    ],
  }),
  component: SubjectViewRoute,
});

function SubjectViewRoute() {
  const { type, frame, tabs, view, cursor, nextHref } = Route.useLoaderData();
  const { state: session } = useSession();
  const { id } = Route.useParams();
  const { data: loaded } = useSuspenseQuery(subjectViewPagesQuery(id, getLocale(), view, cursor));
  const page = loaded.kind === 'page' ? loaded.page : undefined;
  if (!page) throw notFound();
  const { data: reader } = useQuery({
    ...subjectReaderQuery(page.subject!, getLocale()),
    enabled: session === 'signed-in',
  });
  const reviewSession = session === 'unknown' ? 'unavailable' : session;
  const nonce = useRouter().options.ssr?.nonce;
  const locale = getLocale();
  return (
    <SubjectViewPage
      page={page}
      locale={locale}
      messages={subjectPageMessages()}
      reader={reader ?? defaultReader}
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
          locale={locale}
          link={SubjectLink}
          reader={reader ?? defaultReader}
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
        />
      }
      {...(nonce !== undefined ? { nonce } : {})}
      renderJsonLd={false}
    />
  );
}
