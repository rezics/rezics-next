import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { CharacterProfileSession } from '../../features/catalogue/character-profile-session';
import { classificationHandoffSearch } from '../../features/catalogue/classification-create-return';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';

const canonicalCharacter = createServerFn({ method: 'GET', strict: false })
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
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/character`,
          data.search,
        ),
      );
    return { id: canonical.value.id };
  });
export const Route = createFileRoute('/subjects/$id_/$slug_/character')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    work: typeof input.work === 'string' ? input.work : undefined,
    classificationHandoff: classificationHandoffSearch(input),
  }),
  loader: ({ params, location }) =>
    canonicalCharacter({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.character_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: CharacterRoute,
});
function CharacterRoute() {
  const { work, classificationHandoff } = Route.useSearch();
  return (
    <CharacterProfileSession
      id={Route.useLoaderData().id}
      locale={getLocale()}
      work={work}
      {...(classificationHandoff ? { classificationHandoffToken: classificationHandoff } : {})}
    />
  );
}
