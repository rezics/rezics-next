import { isView, type View } from '@rezics/composition';
import { createFileRoute, notFound, redirect, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader, getRequest } from '@tanstack/react-start/server';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { loadSubjectPage, SubjectPage, subjectPageTitle, subjectPageType } from '../../features/pages/subject';
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
  reviews: () => m.subject_reviews(),
  discussion: () => m.subject_discussion(),
  lists: () => m.subject_lists(),
  details: () => m.subject_details(),
} satisfies Record<View, () => string>;

// The view page is the view's own document; the tab bar needs the overview's previews, so both are read together.
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
    const [result, overview, reader] = await Promise.all([
      loadSubjectPage(client, data.id, data.view),
      loadSubjectPage(client, data.id),
      loadReader(client, request, env as Partial<SessionEnv>),
    ]);
    if (result.kind === 'missing' || overview.kind === 'missing') throw notFound();
    if (result.kind === 'redirect')
      throw redirect({ href: `/${data.locale}/subjects/${result.id}/${data.view}`, statusCode: 308 });
    if (overview.kind === 'redirect') throw notFound();
    const type = subjectPageType(overview.page);
    const frame = type ? await typeFrame(type, data.locale) : {};
    return {
      view: data.view,
      page: result.page,
      reader,
      frame,
      tabs: subjectTabs(overview.page),
      title: subjectPageTitle(overview.page, data.locale),
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
  const { page, reader, frame, tabs, title, view } = Route.useLoaderData();
  const { id } = Route.useParams();
  const nonce = useRouter().options.ssr?.nonce;
  const locale = getLocale();
  return (
    <SubjectPage
      page={page}
      locale={locale}
      messages={subjectPageMessages()}
      reader={reader}
      {...(frame.label ? { typeLabel: frame.label } : {})}
      {...(frame.ratio ? { ratio: frame.ratio } : {})}
      link={SubjectLink}
      view={view}
      tabs={tabs}
      tabLabels={viewTabLabels()}
      heading={{
        title: title || m.subject_value_unlabelled(),
        label: viewLabel[view](),
        href: `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(id)}`,
      }}
      {...(nonce !== undefined ? { nonce } : {})}
      renderJsonLd={false}
    />
  );
}
