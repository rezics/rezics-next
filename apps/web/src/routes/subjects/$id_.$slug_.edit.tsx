import { editorRequest } from '../../features/catalogue/editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession, useCandidateWork } from '../../subject/candidate-lifetime';
import { readSubjectCandidates, confirmSubjectCandidate } from '../../features/pages/curate-actions';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
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
import { SubjectFacts } from '../../features/catalogue/subject-facts-view';
import { submitFactCorrection } from '../../features/catalogue/subject-facts-actions';
import { csrfHeaders } from '../../threads/composer';
import { useSession } from '../../session/query';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch } from '../../subject/subject-href';
import { changeOwnContribution, rereadOwnContribution } from '../../features/catalogue/contribution-lifecycle-actions';
import { readSubjectContext, confirmSubjectContext } from '../../features/catalogue/context-curation-actions';
import { candidateContext } from '../../subject/candidates';
import { providerQueueReturnForReview } from '../../features/import-review/provider-queue';
import { providerSessionSource } from '../../features/import-review/provider-visit';
import { subjectChangesReturnForReview } from '../../features/catalogue/subject-changes-navigation';
import { captureCandidateSession } from '../../subject/candidate-lifetime';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  validateSearch: (input: Record<string, unknown>) => {
    const property = typeof input.property === 'string' && input.property.length <= 256 ? input.property : undefined;
    const statement = typeof input.statement === 'string' && input.statement.length <= 128 ? input.statement : undefined;
    const hasExact = input.reviewProperty !== undefined || input.candidate !== undefined || input.context !== undefined;
    const reviewProperty =
      typeof input.reviewProperty === 'string' && input.reviewProperty.length > 0 && input.reviewProperty.length <= 256
        ? input.reviewProperty
        : undefined;
    const candidate = typeof input.candidate === 'string' && uuid.test(input.candidate) ? input.candidate : undefined;
    const context = input.context === undefined ? candidateContext : typeof input.context === 'string' && uuid.test(input.context) ? input.context : undefined;
    const validExact = !!reviewProperty && !!candidate && !!context && !property && !statement;
    return {
      property,
      statement,
      reviewProperty: validExact ? reviewProperty : undefined,
      candidate: validExact ? candidate : undefined,
      context: validExact ? context : undefined,
      returnTo: input.returnTo === 'queue' || input.returnTo === 'changes' ? input.returnTo : undefined,
      reviewInvalid: hasExact && !validExact,
    };
  },
  loader: ({ params, location }) =>
    canonicalEditor({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.facts_title() }, { name: 'robots', content: 'noindex' }] }),
  component: candidateSession(CorrectionRoute),
});

function CorrectionRoute() {
  const queryClient = useQueryClient();
  const { id } = Route.useLoaderData();
  const { property, statement, reviewProperty, candidate, context, returnTo, reviewInvalid } = Route.useSearch();
  const locale = getLocale();
  const candidateWork = useCandidateWork(JSON.stringify([id, locale]));
  const editorWork = useCatalogueLifetime(JSON.stringify([id, locale, property, statement]));
  const { state, subject: reader } = useSession();
  const queueSource = useMemo(() => providerSessionSource(queryClient), [queryClient]);
  const admission = useSyncExternalStore(queueSource.subscribe, queueSource.snapshot, () => null);
  const candidateLease = useMemo(
    () => (state === 'signed-in' && reader ? captureCandidateSession(queryClient, reader) : undefined),
    [queryClient, reader, state],
  );
  const providerReturn =
    returnTo === 'queue' && admission && reviewProperty && candidate && context
      ? providerQueueReturnForReview(queueSource, admission, {
          subject: id,
          property: reviewProperty,
          candidate,
          context,
        })
      : undefined;
  const changesReturn =
    returnTo === 'changes' && candidateLease && reviewProperty && candidate && context
      ? subjectChangesReturnForReview(
          { subject: id, property: reviewProperty, candidate, context },
          candidateLease.reader,
        )
      : undefined;
  const returnHref = providerReturn ? '/imports/review' : changesReturn?.href;
  const returnUnavailable =
    (returnTo === 'queue' && !providerReturn) || (returnTo === 'changes' && !changesReturn);
  const read = async () => {
    const result = await readCorrection({
      data: editorRequest({ id, property, statement }, editorWork),
      headers: csrfHeaders(),
    });
    return editorWork.live() ? result : ({ ok: false, reason: 'denied' } as const);
  };
  const query = useQuery({
    queryKey: ['statement-editor', id, property, statement, locale, candidateWork.generation],
    queryFn: () => (candidateWork.live() ? read() : Promise.resolve({ ok: false, reason: 'denied' } as const)),
    enabled: state === 'signed-in' && !reviewInvalid,
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
  if (reviewInvalid)
    return (
      <p role="alert" className="p-6">
        {m.candidate_unavailable()}
      </p>
    );
  if (query.isError)
    return (
      <div className="space-y-3 p-6">
        <EditorFailure reason="unavailable" locale={locale} />
        <button type="button" onClick={() => candidateWork.live() && void query.refetch()}>
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
  if (!property)
    return (
      <SubjectFacts
        key={`${id}:${locale}`}
        initial={query.data}
        locale={locale}
        transport={{
          read,
          propose: (data) => submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        }}
        initialReview={
          reviewProperty && candidate && context
            ? {
                property: reviewProperty,
                candidate,
                context,
                ...(returnHref ? { returnHref } : {}),
                ...(returnHref
                  ? { returnLabel: returnTo === 'queue' ? m.prq_return_to_queue() : m.changes_return_to_changes() }
                  : {}),
                ...(returnTo ? { returnUnavailable } : {}),
              }
            : undefined
        }
        review={(_property, initialSession, reviewContext) => {
          const exactContext = reviewContext ?? candidateContext;
          return {
            read: async (field, cursor, session = initialSession, work) => {
              if (!work?.live()) return { ok: false, reason: 'denied' };
              const result = exactContext === candidateContext
                ? await readSubjectCandidates({
                    data: { expectedReader: work.reader, id, property: field, cursor, session },
                    headers: csrfHeaders(),
                  })
                : await readSubjectContext({
                    data: { expectedReader: work.reader, id, context: exactContext, property: field, cursor, session },
                    headers: csrfHeaders(),
                  });
              return result;
            },
            confirm: async (command, work) => {
              if (!work?.live()) return { ok: false, reason: 'denied' };
              const result = exactContext === candidateContext
                ? await confirmSubjectCandidate({ data: command, headers: csrfHeaders() })
                : await confirmSubjectContext({
                    data: { ...command, context: exactContext },
                    headers: csrfHeaders(),
                  });
              return result;
            },
          };
        }}
      />
    );
  return (
    <StatementEditor
      key={`${id}:${property}:${statement}:${locale}`}
      initial={query.data}
      locale={locale}
      transport={{
        read,
        propose: (data) => submitCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      }}
      lifecycle={{
        change: (data) => changeOwnContribution({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        read: (data) => rereadOwnContribution({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      }}
      onLifecycleClear={async () => {
        if (!editorWork.live()) return;
        // Cancel in-flight reads before dropping cached subject/candidate payloads.
        await queryClient.cancelQueries({ predicate: (query) => query.queryKey.includes(id) });
        if (!editorWork.live()) return;
        queryClient.setQueriesData(
          { predicate: (query) => query.queryKey.includes(id) && query.queryKey[0] === 'statement-editor' },
          { ok: false, reason: 'unavailable' },
        );
        queryClient.removeQueries({
          predicate: (query) => query.queryKey.includes(id) && query.queryKey[0] !== 'statement-editor',
        });
      }}
      review={(initialSession) => {
        return {
          read: async (field, cursor, session = initialSession, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await readCorrectionReview({
              data: { expectedReader: work.reader, id, property: field, cursor, session },
              headers: csrfHeaders(),
            });
            return result;
          },
          confirm: async (command, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await confirmCorrection({ data: command, headers: csrfHeaders() });
            return result;
          },
        };
      }}
    />
  );
}
