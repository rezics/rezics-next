import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { CharacterProfileSession } from '../../features/catalogue/character-profile-session';
import {
  characterSearchWithinLimit,
  parseCharacterCorrectionSearch,
  parseCharacterCorrectionUrl,
} from '../../features/catalogue/character-correction-visit';
import { classificationHandoffSearch } from '../../features/catalogue/classification-create-return';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { candidateContext } from '../../subject/candidates';
import { canonicalRedirect, keepSearch } from '../../subject/subject-href';

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
      !characterSearchWithinLimit(input.search)
    )
      throw notFound();
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ kernelClient }, { loadSubject }, { loadContextSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
      import('../../features/pages/context-subject'),
    ]);
    const address = parseCharacterCorrectionUrl(data.search);
    if (!address.ok) throw notFound();
    if (
      (address.value.context && address.value.context !== candidateContext && !address.value.realm) ||
      (address.value.realm && !address.value.context)
    )
      return { id: data.id, label: data.slug };
    const canonical = address.value.realm
      ? await loadContextSubject(kernelClient(data.locale), data.id, data.locale, { realm: address.value.realm })
      : await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug)
      throw redirect(
        canonicalRedirect(
          `${canonical.value.href}/character`,
          data.search,
        ),
      );
    return { id: canonical.value.id, label: canonical.value.slug };
  });
export const Route = createFileRoute('/subjects/$id_/$slug_/character')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => {
    const parsed = parseCharacterCorrectionSearch(input);
    if (!parsed.ok) throw notFound();
    return {
      ...parsed.value,
      classificationHandoff: classificationHandoffSearch(input),
    };
  },
  loader: ({ params, location }) =>
    canonicalCharacter({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.character_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: CharacterRoute,
});
function CharacterRoute() {
  const { work, context, realm, classificationHandoff } = Route.useSearch();
  const { id, label } = Route.useLoaderData();
  return (
    <CharacterProfileSession
      id={id}
      label={label}
      locale={getLocale()}
      work={work}
      context={context}
      realm={realm}
      {...(classificationHandoff ? { classificationHandoffToken: classificationHandoff } : {})}
    />
  );
}
