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

const readEditorPage = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; realm?: string; search: string }) => {
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
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    const client = kernelClient(data.locale);
    const [canonical, page] = await Promise.all([
      loadSubject(client, data.id, data.locale as never),
      loadSubjectPage(client, data.id, 'overview', data.locale, data.realm ? { realm: data.realm } : {}),
    ]);
    if (canonical.kind === 'missing' || page.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug)
      throw redirect(canonicalRedirect(subjectUrlForView(canonical.value, 'relation-edit'), data.search));
    if (page.kind !== 'page') throw notFound();
    const frame = subjectFrame(page.page, data.locale);
    if (!frame) throw notFound();
    return {
      page: page.page,
      frame,
      supported: !data.realm && (!page.page.context || page.page.context.id === candidateContext),
    };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/relation-edit')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => ({
    realm: validatePageRealm(search.realm),
    creditHandoff:
      typeof search.creditHandoff === 'string' && /^[0-9a-f-]{36}$/i.test(search.creditHandoff)
        ? search.creditHandoff
        : undefined,
  }),
  loaderDeps: ({ search }) => ({ realm: search.realm }),
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
  const { page, frame, supported } = Route.useLoaderData();
  const { creditHandoff } = Route.useSearch();
  return (
    <article className="mx-auto w-full max-w-4xl space-y-8">
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
          key={`${frame.id}:${creditHandoff ?? ''}`}
          id={frame.id}
          locale={getLocale()}
          {...(creditHandoff ? { creditHandoffToken: creditHandoff } : {})}
        />
      ) : (
        <p>{m.relation_context()}</p>
      )}
    </article>
  );
}
