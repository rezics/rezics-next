import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { ReleaseFidelitySession } from '../../features/catalogue/release-fidelity/session';
import { getLocale } from '../../paraglide/runtime';
import { releaseSearch, releaseVisitFromHash } from '../../features/catalogue/release-fidelity/navigation';
import { subjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';

const canonicalRelease = createServerFn({ method: 'GET', strict: false })
  .validator(
    (input: {
      id: string;
      slug: string;
      locale: string;
      search: string;
      hash: string;
      context: string;
      realm?: string;
    }) => {
      if (
        !input ||
        typeof input.id !== 'string' ||
        input.id.length > 128 ||
        typeof input.slug !== 'string' ||
        input.slug.length > 128 ||
        typeof input.locale !== 'string' ||
        typeof input.search !== 'string' ||
        input.search.length > 32768
      )
        throw notFound();
      if (input.hash && !releaseVisitFromHash(input.hash)) throw notFound();
      releaseSearch({ context: input.context, realm: input.realm });
      return input;
    },
  )
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    // A Realm is not a native Context override. Let the mounted reader explain its unsupported address.
    if (data.realm) return { id: data.id };
    const { subjectKernelClient } = await import('../../features/pages/subject-queries');
    const { client, authorization } = await subjectKernelClient(data.locale, data.context);
    const read = (id: string) =>
      client.subjects({ id }).get({
        query: { context: data.context, language: data.locale },
        headers: authorization ? { authorization } : {},
        fetch: { redirect: 'manual' },
      });
    let current = await read(data.id);
    if (current.status === 308) {
      const body = current.data ?? current.error?.value;
      const target = body && 'redirect' in body ? body.redirect : undefined;
      if (!target || target.from !== data.id || typeof target.to !== 'string') throw notFound();
      current = await read(target.to);
    }
    if (current.status !== 200 || !current.data) return { id: data.id };
    if (current.data.subject.context !== data.context) return { id: data.id };
    const canonical = subjectHref(
      { id: current.data.subject.id, label: pickText(current.data.subject.labels, data.locale).text },
      data.locale,
    );
    if (canonical.params.id !== data.id || canonical.params.slug !== data.slug)
      throw redirect(canonicalRedirect(`${canonical.href}/release`, data.search, data.hash));
    return { id: current.data.subject.id };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/release')({
  staticData: { publicCache: false },
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  validateSearch: (input: Record<string, unknown>) => {
    try {
      const selected = releaseSearch(input);
      const via = subjectVisitReturn(input.via, getLocale());
      if (input.via !== undefined && !via) throw notFound();
      return { ...selected, via };
    } catch {
      throw notFound();
    }
  },
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps, location }) => {
    const query = new URLSearchParams({ context: deps.context });
    for (const key of ['realm', 'reviewProperty', 'candidate', 'via'] as const)
      if (deps[key]) query.set(key, deps[key]);
    return canonicalRelease({
      data: {
        ...params,
        locale: getLocale(),
        context: deps.context,
        realm: deps.realm,
        hash: location.hash ? `#${location.hash.replace(/^#/, '')}` : '',
        search: keepSearch('', query.toString()),
      },
    });
  },
  head: () => ({ meta: [{ title: m.release_fidelity_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: ReleaseRoute,
});

function ReleaseRoute() {
  const { reviewProperty, candidate, context, realm, via } = Route.useSearch();
  return (
    <ReleaseFidelitySession
      id={Route.useLoaderData().id}
      locale={getLocale()}
      context={context}
      realm={realm}
      returnTo={via}
      initialReview={reviewProperty && candidate ? { property: reviewProperty, candidate } : undefined}
    />
  );
}
