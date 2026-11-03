import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { ScreenProfileSession } from '../../features/catalogue/screen-profile-session';
import { classificationHandoffSearch } from '../../features/catalogue/classification-create-return';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';

const canonicalScreen = createServerFn({ method: 'GET', strict: false })
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
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/screen`,
          data.search,
        ),
      );
    return { id: canonical.value.id };
  });
export const Route = createFileRoute('/subjects/$id_/$slug_/screen')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    classificationHandoff: classificationHandoffSearch(input),
  }),
  loader: ({ params, location }) =>
    canonicalScreen({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.screen_edit() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: ScreenRoute,
});
function ScreenRoute() {
  const { classificationHandoff } = Route.useSearch();
  return (
    <ScreenProfileSession
      id={Route.useLoaderData().id}
      locale={getLocale()}
      {...(classificationHandoff ? { classificationHandoffToken: classificationHandoff } : {})}
    />
  );
}
