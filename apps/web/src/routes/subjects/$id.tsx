import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { subjectKernelClient, canonicalRedirect, keepSearch } from '../../features/pages/subject-queries';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { getLocale } from '../../paraglide/runtime.js';

const redirectSubject = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      !('locale' in input) ||
      typeof input.locale !== 'string' ||
      !('search' in input) ||
      typeof input.search !== 'string' ||
      input.search.length > 2048
    )
      throw notFound();
    return { id: input.id, locale: input.locale, search: input.search };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const realm = validatePageRealm(new URLSearchParams(data.search.split('#', 1)[0]).get('realm') ?? undefined);
    const { client, authorization } = await subjectKernelClient(data.locale, realm);
    const { loadContextSubject } = await import('../../features/pages/context-subject');
    const result = await loadContextSubject(client, data.id, data.locale, { realm, authorization });
    if (result.kind === 'missing') throw notFound();
    throw redirect(canonicalRedirect(result.value.href, data.search));
  });

export const Route = createFileRoute('/subjects/$id')({
  staticData: { publicCache: false },
  loader: ({ params, location }) =>
    redirectSubject({
      data: { id: params.id, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
});
