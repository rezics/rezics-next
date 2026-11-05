import { parseMangaPublicVisit, mangaPublicIntentFits } from '../../features/catalogue/manga-public-visit';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { MangaProfileSession } from '../../features/catalogue/manga-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';

const canonicalManga = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      typeof input.search !== 'string' ||
      !mangaPublicIntentFits(input.search)
    )
      throw notFound();
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const path = `/${encodeURIComponent(data.locale)}/subjects/${encodeURIComponent(data.id)}/${encodeURIComponent(data.slug)}/manga`;
    const visit = parseMangaPublicVisit(data.search, data.id, data.locale, path);
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    const canonical = await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug)
      throw redirect(
        canonicalRedirect(
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/manga`,
          canonical.value.id !== data.id && visit ? '?origin=!' : data.search,
        ),
      );
    return { id: canonical.value.id, visit, address: `${path}${data.search}` };
  });
export const Route = createFileRoute('/subjects/$id_/$slug_/manga')({
  staticData: { publicCache: false },
  loader: ({ params, location }) =>
    canonicalManga({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.manga_edit() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: MangaRoute,
});
function MangaRoute() {
  const data = Route.useLoaderData();
  return <MangaProfileSession id={data.id} locale={getLocale()} visit={data.visit} address={data.address} />;
}
