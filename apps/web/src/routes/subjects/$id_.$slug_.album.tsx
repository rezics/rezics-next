import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { AlbumProfileSession } from '../../features/catalogue/album-profile-session';
import { AlbumCurrentVisitGate, AlbumCurrentVisitUnsupported } from '../../features/catalogue/album-current-visit';
import { albumUuid } from '../../features/catalogue/album-profile';
import { parseAlbumCurrentVisitSearch } from '../../features/catalogue/album-current-visit-model';
import { subjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';

const canonicalAlbum = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string; identityOnly?: boolean }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      typeof input.search !== 'string' ||
      input.search.length > 2048 ||
      (input.identityOnly !== undefined && typeof input.identityOnly !== 'boolean') ||
      (input.identityOnly === true && !albumUuid.test(input.id))
    )
      throw notFound();
    return { id: input.id, slug: input.slug, locale: input.locale, search: input.search, identityOnly: !!input.identityOnly };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    if (data.identityOnly) return { id: data.id };
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    const canonical = await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (canonical.kind === 'missing' || canonical.value.id !== data.id) throw notFound();
    if (canonical.value.slug !== data.slug)
      throw redirect(
        canonicalRedirect(
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/album`,
          data.search,
        ),
      );
    return { id: canonical.value.id };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/album')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    unsupportedContext: input.realm !== undefined || input.context !== undefined,
  }),
  loader: async ({ params, location }) => {
    const locale = getLocale();
    const currentVisit = parseAlbumCurrentVisitSearch(location.searchStr, locale, (value, expectedLocale) =>
      subjectVisitReturn(value, expectedLocale),
    );
    const hasVisit = new URLSearchParams(location.searchStr).has('visit');
    const invalidVisit = hasVisit && currentVisit.state === 'unsupported';
    const canonical = await canonicalAlbum({
      data: {
        ...params,
        locale,
        search: invalidVisit ? '' : keepSearch('', location.searchStr, location.hash),
        ...(invalidVisit ? { identityOnly: true } : {}),
      },
    });
    return { ...canonical, currentVisit };
  },
  head: () => ({ meta: [{ title: m.album_edit() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: AlbumRoute,
});
function AlbumRoute() {
  const { unsupportedContext } = Route.useSearch();
  const { id, currentVisit } = Route.useLoaderData();
  const { slug } = Route.useParams();
  const locale = getLocale();
  return unsupportedContext ? (
    <p className="p-6">{m.relation_context()}</p>
  ) : currentVisit.state === 'origin' && currentVisit.origin.subject.id === id ? (
    <AlbumCurrentVisitGate
      key={`${id}:${currentVisit.token}`}
      id={id}
      slug={slug}
      locale={locale}
      origin={currentVisit.origin}
      token={currentVisit.token}
      renderCorrection={() => <AlbumProfileSession id={id} locale={locale} currentVisit />}
    />
  ) : currentVisit.state === 'none' ? (
    <AlbumProfileSession id={id} locale={locale} />
  ) : (
    <AlbumCurrentVisitUnsupported id={id} slug={slug} locale={locale} />
  );
}
