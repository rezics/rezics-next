import { subjectKernelClient } from '../../features/pages/subject-queries';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { ContextNavigation } from '../../features/pages/context-navigation';
import { subjectReaderPartition, useSubjectReaderRefresh } from '../../features/pages/context-reader';
import { useSession } from '../../session/query';
import { PendingPage } from '../../shell/pending';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { SubjectFrame, subjectFrame } from '../../features/pages/subject-frame';
import { SubjectLink, viewTabLabels } from '../../features/pages/route-support';
import { loadSubjectPage } from '../../features/pages/subject';
import { subjectTabs } from '../../features/pages/views';
import { editorialCreateHref } from '../../features/catalogue/editorial-context-route';
import { ContextCurationSession } from '../../features/catalogue/context-curation-session';
import type { CandidateSlot } from '../../subject/candidates';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, subjectUrlForView } from '../../subject/subject-href';

const readContextPage = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string; realm?: string | undefined }) => {
    if (
      !/^[0-9a-f-]{36}$/i.test(input.id) ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35 ||
      typeof input.search !== 'string' ||
      input.search.length > 2048
    )
      throw notFound();
    return { ...input, realm: validatePageRealm(input.realm) };
  })
  .handler(async ({ data }) => {
    const { loadContextSubject, contextSubjectAddress } = await import('../../features/pages/context-subject');
    const { client, authorization, reader } = await subjectKernelClient(data.locale, data.realm);
    const page = await loadSubjectPage(client, data.id, 'overview', data.locale, { realm: data.realm, authorization });
    if (page.kind === 'missing') throw notFound();
    const canonical =
      data.realm && page.kind === 'page'
        ? { kind: 'subject' as const, value: contextSubjectAddress(page.page, data.locale) }
        : await loadContextSubject(client, data.id, data.locale, { realm: data.realm, authorization });
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug || canonical.value.href.includes('/@'))
      throw redirect(canonicalRedirect(subjectUrlForView(canonical.value, 'context-review'), data.search));
    if (page.kind !== 'page') throw notFound();
    const frame = subjectFrame(page.page, data.locale);
    if (!frame) throw notFound();
    return {
      page: page.page,
      frame,
      reader,
    };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/context-review')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (typeof search.context !== 'string' || !uuid.test(search.context)) throw notFound();
    const property = typeof search.property === 'string' && search.property.length <= 256 ? search.property : undefined;
    const slot: CandidateSlot = {};
    for (const key of ['target', 'key'] as const) {
      if (search[key] !== undefined) {
        if (typeof search[key] !== 'string' || !uuid.test(search[key])) throw notFound();
        slot[key] = search[key];
      }
    }
    if (search.sameAs !== undefined) {
      if (
        typeof search.sameAs !== 'string' ||
        search.sameAs.length > 8192 ||
        !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(search.sameAs)
      )
        throw notFound();
      slot.sameAs = search.sameAs;
    }
    if ((slot.target && slot.sameAs) || (slot.key && !slot.target) || (Object.keys(slot).length && !property))
      throw notFound();
    return {
      realm: validatePageRealm(search.realm),
      context: search.context,
      property,
      slot: Object.keys(slot).length ? slot : undefined,
    };
  },

  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  loaderDeps: ({ search }) => ({ realm: search.realm }),
  loader: ({ params, location, deps }) =>
    readContextPage({
      data: {
        realm: deps.realm,
        id: params.id,
        slug: params.slug,
        locale: getLocale(),
        search: location.searchStr,
      },
    }),
  head: () => ({ meta: [{ title: m.context_title() }, { name: 'robots', content: 'noindex' }] }),
  component: ContextReviewRoute,
});
function ContextReviewRoute() {
  const { page, frame, reader } = Route.useLoaderData();
  const { realm, context, property, slot } = Route.useSearch();
  const currentReader = useSubjectReaderRefresh(reader, subjectReaderPartition(realm, reader, useSession()));
  const { slug } = Route.useParams();
  if (!currentReader) return <PendingPage />;
  return (
    <article className="mx-auto w-full max-w-4xl space-y-8">
      <SubjectFrame
        frame={frame}
        context={context}
        realm={realm}
        locale={getLocale()}
        link={SubjectLink}
        unlabelled={m.subject_value_unlabelled()}
        tabs={subjectTabs(page)}
        tabLabels={viewTabLabels()}
        view="overview"
      />
      <ContextNavigation
        context={page.context}
        realm={realm}
        href={subjectUrlForView({ href: `/${getLocale()}/subjects/${frame.id}/${slug}` })}
        locale={getLocale()}
      />
      <h1 className="text-2xl font-semibold">{m.context_title()}</h1>
      <ContextCurationSession
        key={`${frame.id}:${context}:${property ?? ''}:${JSON.stringify(slot)}`}
        id={frame.id}
        context={context}
        property={property}
        slot={slot}
        locale={getLocale()}
        {...(!realm ? { createHref: editorialCreateHref(getLocale(), frame.id, slug) } : {})}
      />
    </article>
  );
}
