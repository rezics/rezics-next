import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { StoryArcProfileSession } from '../../features/catalogue/story-arc-profile-session';
import { classificationHandoffSearch } from '../../features/catalogue/classification-create-return';
import { storyArcUuid } from '../../features/catalogue/story-arc-profile';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';
import { pageText } from '../../features/pages/data';

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
      input.search.length > 2048
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
      const canonical = subjectHref(
        { id: data.id, label: pageText(read.data.subject.labels, data.locale).text },
        data.locale,
      );
      if (canonical.params.slug !== data.slug)
        throw redirect(canonicalRedirect(`${canonical.href}/story-arc`, data.search));
    }
    return { id: data.id };
  });
export const Route = createFileRoute('/subjects/$id_/$slug_/story-arc')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    work: typeof input.work === 'string' ? input.work : undefined,
    realm: validatePageRealm(input.realm),
    classificationHandoff: classificationHandoffSearch(input),
  }),
  loader: ({ params, location }) =>
    canonicalStoryArc({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.story_arc_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: StoryArcRoute,
});
function StoryArcRoute() {
  const { work, realm, classificationHandoff } = Route.useSearch();
  return (
    <StoryArcProfileSession
      id={Route.useLoaderData().id}
      locale={getLocale()}
      work={work}
      realm={realm}
      {...(classificationHandoff ? { classificationHandoffToken: classificationHandoff } : {})}
    />
  );
}
