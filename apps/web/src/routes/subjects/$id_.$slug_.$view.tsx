import { isView, type View } from '@rezics/composition';
import { createFileRoute, notFound, redirect, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { subjectPageType } from '../../features/pages/subject';
import { loadViewPages, SubjectFrame, subjectFrame, SubjectViewPage } from '../../features/pages/subject-frame';
import { subjectTabs } from '../../features/pages/views';
import { kernelClient } from '../../kernel/client';
import { keepSearch, loadSubject, subjectUrlForView, subjectViewPaths } from '../../subject/load-subject';
import type { SessionEnv } from '../../session/client';
import { typeFrame } from '../../subject/definitions';
import { loadReader } from '../../subject/load-reader';
import { useSession } from '../../session/query';
import { validateViewCursor } from '../../features/pages/view-cursor';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { WriteReviewAction } from '../../subject/write-review';
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
        2048 + ('cursor' in input && typeof input.cursor === 'string' ? encodeURIComponent(input.cursor).length : 0)
    )
      throw notFound();
    const cursor = validateViewCursor('cursor' in input ? input.cursor : undefined);
    return {
      id: input.id,
      slug: input.slug,
      view: input.view,
      locale: input.locale,
      search: input.search,
      cursor,
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const client = kernelClient(data.locale);
    const loaded = await loadViewPages(client, data.id, data.view, data.locale, data.cursor);
    if (loaded.kind === 'missing') throw notFound();
    if (loaded.kind === 'redirect') {
      if (loaded.target === 'account')
        throw redirect({
          href: keepSearch(
            `/${encodeURIComponent(data.locale)}/@${encodeURIComponent(loaded.id)}/${data.view}`,
            data.search,
          ),
          statusCode: 308,
        });
      const survivor = await loadSubject(client, loaded.id, data.locale as never);
      if (survivor.kind === 'missing') throw notFound();
      throw redirect({ href: keepSearch(subjectUrlForView(survivor.value, data.view), data.search), statusCode: 301 });
    }
    const canonical = await loadSubject(client, data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug || canonical.value.href.includes('/@'))
      throw redirect({ href: keepSearch(subjectUrlForView(canonical.value, data.view), data.search), statusCode: 301 });
    const reader = await loadReader(client, getRequest(), env as Partial<SessionEnv>);
    const frame = subjectFrame(loaded.overview, data.locale);
    if (!frame) throw notFound();
    const tabs = subjectTabs(loaded.overview);
    if ((data.view === 'reviews' || data.view === 'discussion') && !tabs.some((tab) => tab.view === data.view)) {
      throw redirect({
        href: keepSearch(subjectUrlForView(canonical.value), data.search),
        statusCode: 302,
      });
    }
    const type = subjectPageType(loaded.overview);
    const nextHref =
      loaded.next !== undefined
        ? `${subjectUrlForView(canonical.value, data.view)}?cursor=${encodeURIComponent(loaded.next)}`
        : undefined;
    return {
      view: data.view,
      page: loaded.page,
      reader,
      type: type ? await typeFrame(type, data.locale) : {},
      frame,
      tabs,
      title: frame.title.text,
      cursor: data.cursor,
      nextHref,
      paths: subjectViewPaths(canonical.value.paths, data.view),
    };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/$view')({
  // Validate in the loader: the router wraps validation exceptions as search errors (HTTP 500).
  validateSearch: (search: Record<string, unknown>): { cursor?: unknown } => ({ cursor: search.cursor }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ params, location, deps }) => {
    if (!isView(params.view) || params.view === 'overview') throw notFound();
    return readView({
      data: {
        id: params.id,
        slug: params.slug,
        view: params.view,
        locale: getLocale(),
        search: location.searchStr,
        cursor: validateViewCursor(deps.cursor),
      },
    });
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
  const { page, reader, type, frame, tabs, view, nextHref } = Route.useLoaderData();
  const { state: session } = useSession();
  const reviewSession = session === 'unknown' ? 'unavailable' : session;
  const nonce = useRouter().options.ssr?.nonce;
  const locale = getLocale();
  return (
    <>
      <SubjectViewPage
        page={page}
        locale={locale}
        messages={subjectPageMessages()}
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
          />
        }
        {...(nonce !== undefined ? { nonce } : {})}
        renderJsonLd={false}
      />
    </>
  );
}
