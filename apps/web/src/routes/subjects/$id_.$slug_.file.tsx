import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { CatalogueFileProfileSession } from '../../features/catalogue/catalogue-file-profile/session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';

const canonicalFile = createServerFn({ method: 'GET', strict: false })
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
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug)
      throw redirect(
        canonicalRedirect(
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/file`,
          data.search,
        ),
      );
    return { id: canonical.value.id };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/file')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    reviewProperty:
      typeof input.reviewProperty === 'string' && input.reviewProperty.length <= 256 ? input.reviewProperty : undefined,
    candidate:
      typeof input.candidate === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.candidate)
        ? input.candidate
        : undefined,
  }),
  loader: ({ params, location }) =>
    canonicalFile({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.catalogue_file_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: FileRoute,
});

function FileRoute() {
  const { reviewProperty, candidate } = Route.useSearch();
  return (
    <CatalogueFileProfileSession
      id={Route.useLoaderData().id}
      locale={getLocale()}
      initialReview={reviewProperty && candidate ? { property: reviewProperty, candidate } : undefined}
    />
  );
}
