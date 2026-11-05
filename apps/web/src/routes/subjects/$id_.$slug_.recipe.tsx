import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { RecipeEditorSession } from '../../features/catalogue/recipe-editor-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { parseRecipeVisit, recipeVisitByteLimit } from '../../features/catalogue/recipe-current-visit';
import { candidateContext } from '../../subject/candidates';
import { contextHref } from '../../features/pages/context-navigation';
import { canonicalRedirect, keepSearch } from '../../subject/subject-href';

const canonicalRecipe = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      typeof input.search !== 'string' ||
      new TextEncoder().encode(input.search).byteLength > recipeVisitByteLimit
    )
      throw notFound();
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const intent = parseRecipeVisit(data.search);
    if (!intent.valid) return { id: data.id, intent };
    const [{ kernelClient }, { loadContextSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../features/pages/context-subject'),
    ]);
    const canonical = await loadContextSubject(kernelClient(data.locale), data.id, data.locale, {
      realm: intent.visit.realm,
    });
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug)
      throw redirect(canonicalRedirect(`${canonical.value.href}/recipe`, data.search));
    return {
      id: canonical.value.id,
      intent,
      sourceHref:
        intent.visit.context === candidateContext || intent.visit.realm
          ? contextHref(canonical.value.href, intent.visit.realm)
          : undefined,
    };
  });
export const Route = createFileRoute('/subjects/$id_/$slug_/recipe')({
  staticData: { publicCache: false },
  loader: ({ params, location }) =>
    canonicalRecipe({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr) },
    }),
  head: () => ({ meta: [{ title: m.recipe_edit() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: RecipeRoute,
});
function RecipeRoute() {
  const loaded = Route.useLoaderData();
  return (
    <RecipeEditorSession
      id={loaded.id}
      locale={getLocale()}
      intent={loaded.intent}
      context={loaded.intent.valid ? loaded.intent.visit.context : 'invalid'}
      sourceHref={loaded.sourceHref}
    />
  );
}
