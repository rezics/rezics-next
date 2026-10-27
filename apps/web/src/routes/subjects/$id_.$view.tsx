import { isView, type View } from '@rezics/composition';
import { createFileRoute, notFound, redirect, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader, getRequest } from '@tanstack/react-start/server';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { subjectPageType } from '../../features/pages/subject';
import { loadViewPages, SubjectFrame, subjectFrame, SubjectViewPage } from '../../features/pages/subject-frame';
import { subjectTabs } from '../../features/pages/views';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { typeFrame } from '../../subject/definitions';
import { loadReader } from '../../subject/load-reader';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
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

// The view page is the view's own document; the tab bar and the frame need the overview's page, so both are read together.
const readView = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      !('view' in input) ||
      !isView(input.view) ||
      !('locale' in input) ||
      typeof input.locale !== 'string'
    )
      throw notFound();
    return { id: input.id, view: input.view, locale: input.locale };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const client = kernelClient(data.locale);
    const request = getRequest();
    const [loaded, reader] = await Promise.all([
      loadViewPages(client, data.id, data.view),
      loadReader(client, request, env as Partial<SessionEnv>),
    ]);
    if (loaded.kind === 'missing') throw notFound();
    if (loaded.kind === 'redirect')
      throw redirect({ href: `/${data.locale}/subjects/${loaded.id}/${data.view}`, statusCode: 308 });
    const frame = subjectFrame(loaded.overview, data.locale);
    if (!frame) throw notFound();
    const type = subjectPageType(loaded.overview);
    return {
      view: data.view,
      page: loaded.page,
      reader,
      type: type ? await typeFrame(type, data.locale) : {},
      frame,
      tabs: subjectTabs(loaded.overview),
      title: frame.title.text,
    };
  });

export const Route = createFileRoute('/subjects/$id_/$view')({
  loader: ({ params }) => {
    // The overview is the subject's own address, not a view address.
    if (!isView(params.view) || params.view === 'overview') throw notFound();
    return readView({ data: { id: params.id, view: params.view, locale: getLocale() } });
  },
  head: ({ loaderData }) => ({
    meta: [
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
  const { page, reader, type, frame, tabs, view } = Route.useLoaderData();
  const nonce = useRouter().options.ssr?.nonce;
  const locale = getLocale();
  return (
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
  );
}
