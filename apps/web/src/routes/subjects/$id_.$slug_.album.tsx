import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { AlbumProfileSession } from '../../features/catalogue/album-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';

const canonicalAlbum = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      typeof input.search !== 'string' ||
      input.search.length > 2048
    )
      throw notFound();
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
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
  loader: ({ params, location }) =>
    canonicalAlbum({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.album_edit() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: AlbumRoute,
});
function AlbumRoute() {
  const { unsupportedContext } = Route.useSearch();
  const { id } = Route.useLoaderData();
  return unsupportedContext ? (
    <p className="p-6">{m.relation_context()}</p>
  ) : (
    <AlbumProfileSession id={id} locale={getLocale()} />
  );
}
