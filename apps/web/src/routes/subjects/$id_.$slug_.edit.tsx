import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { StatementEditor, EditorFailure } from '../../features/catalogue/statement-editor-view';
import {
  readCorrection,
  submitCorrection,
  readCorrectionReview,
  confirmCorrection,
} from '../../features/catalogue/statement-editor-actions';
import { csrfHeaders } from '../../threads/composer';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch } from '../../subject/subject-href';

const canonicalEditor = createServerFn({ method: 'GET', strict: false })
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
          `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/edit`,
          data.search,
        ),
      );
    }
    return { id: canonical.value.id };
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/edit')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    property: typeof input.property === 'string' && input.property.length <= 256 ? input.property : undefined,
    statement: typeof input.statement === 'string' && input.statement.length <= 128 ? input.statement : undefined,
  }),
  loader: ({ params, location }) =>
    canonicalEditor({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.correction_title() }, { name: 'robots', content: 'noindex' }] }),
  component: CorrectionRoute,
});

function CorrectionRoute() {
  const { id } = Route.useLoaderData();
  const { property, statement } = Route.useSearch();
  const locale = getLocale();
  const { state } = useSession();
  const read = () => readCorrection({ data: { id, property, statement }, headers: csrfHeaders() });
  const query = useQuery({
    queryKey: ['statement-editor', id, property, statement, locale],
    queryFn: read,
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
  if (query.isError)
    return (
      <div className="space-y-3 p-6">
        <EditorFailure reason="unavailable" locale={locale} />
        <button type="button" onClick={() => void query.refetch()}>
          {m.correction_reload()}
        </button>
      </div>
    );
  if (!query.data)
    return (
      <p role="status" className="p-6">
        {m.candidate_loading()}
      </p>
    );
  return (
    <StatementEditor
      key={`${id}:${property}:${statement}:${locale}`}
      initial={query.data}
      locale={locale}
      transport={{ read, propose: (data) => submitCorrection({ data, headers: csrfHeaders() }) }}
      review={(initialSession) => {
        let session = initialSession;
        return {
          read: async (field, cursor) => {
            const result = await readCorrectionReview({
              data: { id, property: field, cursor, session },
              headers: csrfHeaders(),
            });
            if (result.ok && result.session) session = result.session;
            return result;
          },
          confirm: async (command) => {
            const result = await confirmCorrection({ data: { ...command, session }, headers: csrfHeaders() });
            if (result.ok && result.session) session = result.session;
            return result;
          },
        };
      }}
    />
  );
}
