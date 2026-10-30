import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { Button } from '@rezics/ui/shadcn/button';
import { AuthoredField } from '../../features/catalogue/authored-field-view';
import {
  loadAuthoredField,
  submitAuthoredField,
  loadAuthoredReview,
  confirmAuthoredField,
} from '../../features/catalogue/authored-field-actions';
import { EditorFailure } from '../../features/catalogue/statement-editor-view';
import { csrfHeaders } from '../../threads/composer';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch } from '../../subject/subject-href';

const canonicalAuthored = createServerFn({ method: 'GET', strict: false })
  .validator((value: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !value ||
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      typeof value.slug !== 'string' ||
      value.slug.length > 128 ||
      typeof value.locale !== 'string' ||
      typeof value.search !== 'string' ||
      value.search.length > 2048
    )
      throw notFound();
    return value;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    const canonical = await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    // The subject editor keeps the canonical subject id even when reading uses an account address.
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug) {
      const { subjectHref } = await import('../../subject/subject-href');
      throw redirect(
        canonicalRedirect(
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/authored`,
          data.search,
        ),
      );
    }
    return { id: canonical.value.id };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/authored')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    property: typeof input.property === 'string' && input.property.length <= 256 ? input.property : undefined,
  }),
  loader: ({ params, location }) =>
    canonicalAuthored({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.authored_title() }, { name: 'robots', content: 'noindex' }] }),
  component: AuthoredRoute,
});

function AuthoredRoute() {
  const { id } = Route.useLoaderData();
  const { property } = Route.useSearch();
  const locale = getLocale();
  const { state } = useSession();
  const read = (field = property, session?: string) =>
    loadAuthoredField({ data: { id, property: field, session }, headers: csrfHeaders() });
  const query = useQuery({
    queryKey: ['authored-field', id, property, locale],
    queryFn: () => read(),
    enabled: state === 'signed-in',
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (state === 'signed-out')
    return (
      <div className="p-6">
        <EditorFailure reason="denied" locale={locale} />
      </div>
    );
  if (query.isError && !query.data)
    return (
      <div className="space-y-3 p-6">
        <EditorFailure reason="unavailable" locale={locale} />
        <Button variant="outline" onClick={() => void query.refetch()}>
          {m.correction_reload()}
        </Button>
      </div>
    );
  if (!query.data)
    return (
      <p role="status" className="p-6">
        {m.candidate_loading()}
      </p>
    );
  return (
    <AuthoredField
      key={`${id}:${property}:${locale}`}
      initial={query.isError ? { ok: false, reason: 'unavailable' } : query.data}
      locale={locale}
      transport={{
        read,
        propose: (data) => submitAuthoredField({ data, headers: csrfHeaders() }),
        review: (field, candidate, cursor, session) =>
          loadAuthoredReview({ data: { id, property: field, candidate, cursor, session }, headers: csrfHeaders() }),
      }}
      confirm={(data) => confirmAuthoredField({ data, headers: csrfHeaders() })}
    />
  );
}
