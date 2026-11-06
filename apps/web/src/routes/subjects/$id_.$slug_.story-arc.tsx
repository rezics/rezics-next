import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { StoryArcProfileSession } from '../../features/catalogue/story-arc-profile-session';
import { classificationHandoffSearch } from '../../features/catalogue/classification-create-return';
import { storyArcUuid } from '../../features/catalogue/story-arc-profile';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch } from '../../subject/subject-href';
import { pageText } from '../../features/pages/data';
import {
  parseStoryArcProfileSearch,
  storyArcCanonicalSlugTarget,
  storyArcGlobalChoiceHref,
  storyArcProfileSearch,
} from '../../features/catalogue/story-arc-public-visit';

const canonicalStoryArc = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      !storyArcUuid.test(input.id) ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      input.locale.length > 35 ||
      typeof input.search !== 'string' ||
      input.search.length > 2048 ||
      new TextEncoder().encode(input.search).byteLength > 2048
    )
      throw notFound();
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const { kernelClient } = await import('../../kernel/client');
    const read = await kernelClient(data.locale)
      .subjects({ id: data.id })
      .get({ fetch: { redirect: 'manual' } });
    // Identity redirects are shown by the editor as stale; only a slug on the same identity is canonicalized.
    if (read.status === 200 && read.data?.subject.id === data.id) {
      const target = storyArcCanonicalSlugTarget({
        id: data.id,
        slug: data.slug,
        currentId: read.data.subject.id,
        label: pageText(read.data.subject.labels, data.locale).text,
        locale: data.locale,
      });
      if (target) throw redirect(canonicalRedirect(`${target}/story-arc`, data.search));
    }
    return { id: data.id };
  });
export const Route = createFileRoute('/subjects/$id_/$slug_/story-arc')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => {
    const parsed = storyArcProfileSearch(input, getLocale());
    if (!parsed) throw notFound();
    return {
      ...parsed,
      realm: validatePageRealm(parsed.realm),
      classificationHandoff: classificationHandoffSearch(input),
    };
  },
  loader: ({ params, location }) => {
    const locale = getLocale();
    if (!parseStoryArcProfileSearch(location.searchStr, params.id, locale)) throw notFound();
    return canonicalStoryArc({
      data: { ...params, locale, search: keepSearch('', location.searchStr, location.hash) },
    });
  },
  head: () => ({ meta: [{ title: m.story_arc_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: StoryArcRoute,
});
function StoryArcRoute() {
  const { work, realm, context, definition, via, classificationHandoff } = Route.useSearch();
  const { id, slug } = Route.useParams();
  const locale = getLocale();
  return (
    <StoryArcProfileSession
      id={Route.useLoaderData().id}
      locale={locale}
      work={work}
      realm={realm}
      context={context}
      definition={definition}
      via={via}
      address={JSON.stringify([definition, via])}
      globalChoiceHref={storyArcGlobalChoiceHref({ id, slug, locale, ...(via ? { via } : {}) })}
      {...(classificationHandoff ? { classificationHandoffToken: classificationHandoff } : {})}
    />
  );
}
