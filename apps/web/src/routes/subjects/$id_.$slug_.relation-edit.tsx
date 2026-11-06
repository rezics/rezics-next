import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { SubjectFrame, subjectFrame } from '../../features/pages/subject-frame';
import { SubjectLink, viewTabLabels } from '../../features/pages/route-support';
import { loadSubjectPage } from '../../features/pages/subject';
import { subjectTabs } from '../../features/pages/views';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { RelationEditorSession } from '../../features/catalogue/relation-editor-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { candidateContext } from '../../subject/candidates';
import { canonicalRedirect, subjectUrlForView } from '../../subject/subject-href';
import { subjectVisitReturn, subjectRouteSearchLimit } from '../../features/pages/subject-visit-navigation';
import {
  parseRelationPublicVisit,
  relationPublicFreshHref,
  relationPublicVisitUnsupported,
  type RelationPublicVisit,
} from '../../features/catalogue/relation-public-visit';

const publicSearchLimit = 32_768;

function relationEditPath(id: string, slug: string, locale: string): string {
  return `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(id)}/${encodeURIComponent(slug)}/relation-edit`;
}

const readEditorPage = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; realm?: string; search: string }) => {
    const publicVisitAddress = /(?:^|[?&])(?:origin|publicReturn)(?:=|%|&|$)/iu.test(input.search);
    if (
      !/^[0-9a-f-]{36}$/i.test(input.id) ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35 ||
      typeof input.search !== 'string' ||
      input.search.length > (publicVisitAddress ? publicSearchLimit : subjectRouteSearchLimit(input.search))
    )
      throw notFound();
    return { ...input, realm: validatePageRealm(input.realm) };
  })
  .handler(async ({ data }) => {
    const visit = parseRelationPublicVisit(
      data.search,
      data.id,
      data.locale,
      relationEditPath(data.id, data.slug, data.locale),
    );
    if (visit.kind === 'invalid') return { kind: 'invalid' as const, visit };
    if (visit.kind === 'origin' && relationPublicVisitUnsupported(visit))
      return {
        kind: 'unsupported' as const,
        visit,
        routePath: relationEditPath(data.id, data.slug, data.locale),
      };
    const { kernelClient } = await import('../../kernel/client');
    const { loadSubject } = await import('../../subject/load-subject');
    const client = kernelClient(data.locale);
    const [canonical, page] = await Promise.all([
      loadSubject(client, data.id, data.locale as never),
      loadSubjectPage(client, data.id, 'overview', data.locale, data.realm ? { realm: data.realm } : {}),
    ]);
    if (canonical.kind === 'missing' || page.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug) {
      const identityChanged = canonical.value.id.toLowerCase() !== data.id.toLowerCase();
      const search = identityChanged && (visit.kind === 'origin' || visit.kind === 'fresh') ? '?origin=!' : data.search;
      throw redirect(canonicalRedirect(subjectUrlForView(canonical.value, 'relation-edit'), search));
    }
    if (page.kind !== 'page') throw notFound();
    const frame = subjectFrame(page.page, data.locale);
    if (!frame) throw notFound();
    return {
      kind: 'page' as const,
      page: page.page,
      frame,
      visit,
      supported:
        !data.realm &&
        (visit.kind === 'origin'
          ? visit.origin.context === candidateContext &&
            (page.page.context?.id ?? candidateContext) === visit.origin.context
          : !page.page.context || page.page.context.id === candidateContext),
      realm: data.realm,
      routePath: relationEditPath(data.id, data.slug, data.locale),
    };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/relation-edit')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => ({
    realm: validatePageRealm(search.realm),
    via: subjectVisitReturn(search.via, getLocale()),
    creditHandoff:
      typeof search.creditHandoff === 'string' && /^[0-9a-f-]{36}$/i.test(search.creditHandoff)
        ? search.creditHandoff
        : undefined,
    relatedWorkHandoff:
      typeof search.relatedWorkHandoff === 'string' && /^[0-9a-f-]{36}$/i.test(search.relatedWorkHandoff)
        ? search.relatedWorkHandoff
        : undefined,
    origin: typeof search.origin === 'string' ? search.origin : search.origin === undefined ? undefined : '!',
    publicReturn:
      typeof search.publicReturn === 'string'
        ? search.publicReturn
        : search.publicReturn === undefined
          ? undefined
          : '!',
  }),
  loaderDeps: ({ search }) => ({ realm: search.realm, origin: search.origin, publicReturn: search.publicReturn }),
  loader: ({ params, deps, location }) =>
    readEditorPage({
      data: {
        id: params.id,
        slug: params.slug,
        locale: getLocale(),
        ...(deps.realm ? { realm: deps.realm } : {}),
        search: location.searchStr,
      },
    }),
  head: () => ({ meta: [{ title: m.relation_title() }, { name: 'robots', content: 'noindex' }] }),
  component: RelationEditRoute,
});
function RelationEditRoute() {
  const data = Route.useLoaderData();
  const { creditHandoff, relatedWorkHandoff, via } = Route.useSearch();
  if (data.kind === 'invalid')
    return (
      <article className="mx-auto w-full max-w-4xl space-y-8">
        <p role="alert">{m.relation_public_invalid()}</p>
      </article>
    );
  if (data.kind === 'unsupported') {
    const { origin } = data.visit;
    const general = !origin.realm && origin.context !== candidateContext;
    return (
      <article className="mx-auto w-full max-w-4xl space-y-8">
        <p role="alert">{m.relation_public_unsupported()}</p>
        <a
          className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
          href={origin.returnHref}
        >
          {general ? m.relation_public_general_return() : m.relation_public_return()}
        </a>
        <a
          className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
          href={relationPublicFreshHref(data.routePath, origin.returnHref)}
        >
          {m.relation_public_fresh_global()}
        </a>
      </article>
    );
  }
  const { page, frame, supported, visit, routePath } = data;
  const publicReturn =
    visit.kind === 'origin' ? visit.origin.returnHref : visit.kind === 'fresh' ? visit.returnHref : undefined;
  const observedUnsupported = visit.kind === 'origin' && !supported;
  const freshReturn =
    visit.kind === 'fresh' ? visit.returnHref : visit.kind === 'origin' ? visit.origin.returnHref : undefined;
  const generalPublicReturn =
    publicReturn && !new URL(publicReturn, 'https://rezics.invalid').searchParams.has('realm');
  const editorKey = [
    getLocale(),
    frame.id,
    routePath,
    page.context?.id ?? candidateContext,
    data.realm ?? '',
    page.catalogue?.digest ?? '',
    JSON.stringify(visit),
    via ?? '',
    creditHandoff ?? '',
    relatedWorkHandoff ?? '',
  ].join(':');
  return (
    <article className="mx-auto w-full max-w-4xl space-y-8">
      {publicReturn ? (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <a
            className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
            href={publicReturn}
          >
            {generalPublicReturn ? m.relation_public_general_return() : m.relation_public_return()}
          </a>
          {visit.kind === 'fresh' ? <p>{m.relation_public_fresh_notice()}</p> : null}
        </div>
      ) : via ? (
        <p>
          <a className="inline-flex min-h-11 items-center text-primary underline underline-offset-4" href={via}>
            {m.recording_reader_return({}, { locale: getLocale() as never })}
          </a>
        </p>
      ) : null}
      <SubjectFrame
        frame={frame}
        locale={getLocale()}
        link={SubjectLink}
        unlabelled={m.subject_value_unlabelled()}
        tabs={subjectTabs(page)}
        tabLabels={viewTabLabels()}
        view="overview"
      />
      {supported ? (
        <RelationEditorSession
          key={editorKey}
          id={frame.id}
          locale={getLocale()}
          {...(creditHandoff ? { creditHandoffToken: creditHandoff } : {})}
          {...(relatedWorkHandoff ? { relatedWorkHandoffToken: relatedWorkHandoff } : {})}
        />
      ) : observedUnsupported && freshReturn ? (
        <div className="space-y-3">
          <p role="alert">{m.relation_public_unsupported()}</p>
          <a
            className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
            href={relationPublicFreshHref(routePath, freshReturn)}
          >
            {m.relation_public_fresh_global()}
          </a>
        </div>
      ) : (
        <p>{m.relation_context()}</p>
      )}
    </article>
  );
}
