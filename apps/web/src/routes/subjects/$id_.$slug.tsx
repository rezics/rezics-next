import { contextSubjectAddress } from '../../features/pages/context-subject';
import { contextHref } from '../../features/pages/context-navigation';
import { PendingPage } from '../../shell/pending';
import { subjectReaderPartition, useSubjectReaderRefresh } from '../../features/pages/context-reader';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { createFileRoute, notFound, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { useQuery, useSuspenseQuery, useSuspenseQueries, useQueryClient } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { isView } from '@rezics/composition';
import { SubjectPage, pageRelationProperties, subjectPageTitle, subjectPageType } from '../../features/pages/subject';
import { subjectHead } from '../../features/pages/subject-head';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { subjectTabs } from '../../features/pages/views';
import { SubjectHeaderActions } from '../../features/pages/subject-reactions-view';
import { SubjectCandidateCuration } from '../../features/pages/curate-view';
import {
  RatingControlContext,
  RatingsContext,
  RatingsRecoveryContext,
  RatingPopulationsContext,
} from '../../features/pages/subject-ratings-view';
import { RATING_SOURCES, type RatingSources, type RatingSource } from '../../features/pages/subject-ratings';
import { SubjectRatingPopulations } from '../../features/pages/subject-rating-populations-view';
import { useSubjectPersonalReader } from '../../features/pages/subject-personal-reader';
import { useSubjectReactionReader } from '../../features/pages/subject-reaction-reader';
import { postSubjectRatingForm } from '../../features/pages/rating-actions';
import {
  subjectFrameQuery,
  subjectLibraryQuery,
  subjectCanonicalQuery,
  subjectRequestReader,
  subjectKernelClient,
  canonicalRedirect,
  accountHref,
  keepSearch,
  subjectPageQuery,
  subjectRatingQuery,
  subjectRelationsQuery,
  subjectReactionsQuery,
  subjectUrlForView,
} from '../../features/pages/subject-queries';
import { SubjectLibrarySlot } from '../../library/subject-slot-view';
import { submitSubjectLabelForm } from '../../library/subject-slot-form-action';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../../session/client';
import { pageHeadContext } from '../../shell/head-context';

// Page documents type their props as unknown. The kernel already returned JSON.
const readSubject = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      !('slug' in input) ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      !('locale' in input) ||
      typeof input.locale !== 'string' ||
      !('search' in input) ||
      typeof input.search !== 'string' ||
      input.search.length > 2048 ||
      !('loadCollections' in input) ||
      typeof input.loadCollections !== 'boolean' ||
      !('slotResult' in input) ||
      (input.slotResult !== undefined && typeof input.slotResult !== 'string') ||
      !('view' in input) ||
      (input.view !== undefined && !isView(input.view))
    )
      throw notFound();
    return {
      realm: validatePageRealm('realm' in input ? input.realm : undefined),
      reader: 'reader' in input && typeof input.reader === 'string' ? input.reader : null,
      id: input.id,
      slug: input.slug,
      locale: input.locale,
      search: input.search,
      loadCollections: input.loadCollections,
      slotResult: input.slotResult as string | undefined,
      view: input.view as string | undefined,
    };
  })
  .handler(async ({ data }) => {
    let paths;
    if (!data.realm) {
      const { client } = await subjectKernelClient(data.locale);
      const { loadContextSubject } = await import('../../features/pages/context-subject');
      const canonical = await loadContextSubject(client, data.id, data.locale);
      if (canonical.kind === 'missing') throw notFound();
      const requestedView = canonical.value.slug === data.slug ? undefined : data.view;
      if (canonical.value.id !== data.id || canonical.value.slug !== data.slug || canonical.value.href.includes('/@'))
        throw redirect(canonicalRedirect(subjectUrlForView(canonical.value, requestedView), data.search));
      paths = canonical.value.paths;
    }

    const config = env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SCRIPT_URL?: string };
    const verification = {
      sitekey: config.TURNSTILE_SITE_KEY ?? '',
      scriptUrl:
        (import.meta.env.DEV && config.TURNSTILE_SCRIPT_URL) ||
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    };
    return {
      verification,
      paths,
    };
  });

export const Route = createFileRoute('/subjects/$id_/$slug')({
  staticData: { publicCache: false },
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        const contentLength = request.headers.get('content-length');
        const canReadForm =
          contentType === 'application/x-www-form-urlencoded' &&
          (contentLength === null || (/^\d+$/.test(contentLength) && Number(contentLength) <= 4 * 1024));
        const fields = canReadForm
          ? await request
              .clone()
              .formData()
              .catch(() => null)
          : null;
        const intents = fields?.getAll('intent') ?? [];
        const intent =
          intents.length === 1 &&
          typeof intents[0] === 'string' &&
          ['assign-by-name', 'label-step', 'unassign', 'restore'].includes(intents[0])
            ? intents[0]
            : null;
        if (intent) {
          const result = await submitSubjectLabelForm(request);
          if (result instanceof Response) return result;
          const url = new URL(request.url);
          url.searchParams.delete('labelResult');
          url.searchParams.delete('undoLabelId');
          url.searchParams.delete('undoAssignmentId');
          url.searchParams.delete('undoRevision');
          url.searchParams.delete('undoKey');
          url.searchParams.delete('ratingFailure');
          if (result.ok && intent === 'unassign' && result.restoreRevision !== undefined) {
            url.searchParams.set('labelResult', 'label-removed');
            url.searchParams.set('undoLabelId', String(fields?.get('labelId') ?? ''));
            url.searchParams.set('undoAssignmentId', String(fields?.get('assignmentId') ?? ''));
            url.searchParams.set('undoRevision', String(result.restoreRevision));
            url.searchParams.set('undoKey', crypto.randomUUID());
          } else if (!result.ok) {
            if (intent === 'restore') {
              url.searchParams.set('undoLabelId', String(fields?.get('labelId') ?? ''));
              url.searchParams.set('undoAssignmentId', String(fields?.get('assignmentId') ?? ''));
              url.searchParams.set('undoRevision', String(fields?.get('revision') ?? ''));
              url.searchParams.set('undoKey', String(fields?.get('idempotencyKey') ?? ''));
            }
            const value =
              result.reason === 'capacity'
                ? 'label-capacity'
                : result.reason.startsWith('restore-')
                  ? `label-${result.reason}`
                  : result.reason === 'closed'
                    ? 'closed'
                    : 'unavailable';
            url.searchParams.set('labelResult', value);
          }
          return new Response(null, {
            status: 303,
            headers: { location: url.pathname + url.search, 'cache-control': 'private, no-store' },
          });
        }
        const { kernelClient } = await import('../../kernel/client');
        const result = await postSubjectRatingForm(kernelClient(), request, env as Partial<SessionEnv>);
        const url = new URL(request.url);
        if (result === 'signed-out')
          return new Response(null, {
            status: 303,
            headers: {
              location: `/auth/sign-in?return_to=${encodeURIComponent(url.pathname)}`,
              'cache-control': 'private, no-store',
            },
          });
        if (result === 'failure') url.searchParams.set('ratingFailure', '1');
        else url.searchParams.delete('ratingFailure');
        return new Response(null, {
          status: 303,
          headers: { location: url.pathname + url.search, 'cache-control': 'private, no-store' },
        });
      },
    },
  },
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    realm?: string | undefined;
    slot?: 'collections';
    slotResult?: string;
    ratingFailure?: true;
    labelResult?: string;
    undoLabelId?: string;
    undoAssignmentId?: string;
    undoRevision?: number;
    undoKey?: string;
  } => ({
    realm: validatePageRealm(search.realm),
    ...(search.slot === 'collections' ? { slot: 'collections' as const } : {}),
    ...(typeof search.slotResult === 'string' ? { slotResult: search.slotResult } : {}),
    ...(search.ratingFailure === '1' ? { ratingFailure: true as const } : {}),
    ...(typeof search.labelResult === 'string' ? { labelResult: search.labelResult } : {}),
    ...(typeof search.undoLabelId === 'string' ? { undoLabelId: search.undoLabelId } : {}),
    ...(typeof search.undoAssignmentId === 'string' ? { undoAssignmentId: search.undoAssignmentId } : {}),
    ...(typeof search.undoKey === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search.undoKey)
      ? { undoKey: search.undoKey }
      : {}),
    ...(typeof search.undoRevision === 'number' ||
    (typeof search.undoRevision === 'string' && /^\d+$/.test(search.undoRevision))
      ? { undoRevision: Number(search.undoRevision) }
      : {}),
  }),
  loaderDeps: ({ search }) => ({
    realm: search.realm,
    slot: search.slot,
    slotResult: search.slotResult,
    labelResult: search.labelResult,
    undoLabelId: search.undoLabelId,
    undoAssignmentId: search.undoAssignmentId,
    undoRevision: search.undoRevision,
  }),
  loader: async ({ params, deps, location, context }) => {
    const reader = await subjectRequestReader({ data: { realm: deps.realm } });
    const data = await readSubject({
      data: {
        realm: deps.realm,
        reader,
        id: params.id,
        slug: params.slug,
        locale: getLocale(),
        search: keepSearch('', location.searchStr, location.hash),
        loadCollections: deps.slot === 'collections',
        slotResult: deps.slotResult,
        view: isView(params.slug) && params.slug !== 'overview' ? params.slug : undefined,
      },
    });
    const view = 'overview' as const;
    // Fetch current native proof for both the reading and its permitted share-card projection.
    const pageQuery = subjectPageQuery(params.id, getLocale(), view, deps.realm, reader);
    const page = await context.queryClient.fetchQuery(pageQuery);
    if (page.kind === 'redirect') {
      if (page.target === 'account')
        throw redirect(canonicalRedirect(accountHref(getLocale(), page.id, view), location.searchStr, location.hash));
      const survivor = await context.queryClient.fetchQuery(
        subjectCanonicalQuery(page.id, getLocale(), deps.realm, reader),
      );
      if (survivor.kind === 'missing') throw notFound();
      throw redirect({
        href: keepSearch(subjectUrlForView(survivor.value, view), location.searchStr, location.hash),
        statusCode: 301,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    if (page.kind !== 'page') throw notFound();
    const address = deps.realm ? contextSubjectAddress(page.page, getLocale()) : undefined;
    if (address && address.slug !== params.slug)
      throw redirect(
        canonicalRedirect(
          subjectUrlForView(address, isView(params.slug) ? params.slug : undefined),
          location.searchStr,
          location.hash,
        ),
      );
    const type = subjectPageType(page.page);
    const [frame, relations, reactions, ratings] = await Promise.all([
      type
        ? context.queryClient.ensureQueryData(subjectFrameQuery(type, getLocale()))
        : Promise.resolve({ label: undefined, ratio: undefined, schemaOrgType: undefined }),
      context.queryClient.ensureQueryData(subjectRelationsQuery(pageRelationProperties(page.page), getLocale())),
      context.queryClient.ensureQueryData(subjectReactionsQuery(params.id, getLocale())),
      Promise.all(
        RATING_SOURCES.map((source) =>
          context.queryClient.ensureQueryData(subjectRatingQuery(params.id, getLocale(), source)),
        ),
      ).then(([question, figure, global, statistics]): RatingSources => ({
        question: question!.question,
        figure: figure!.figure,
        global: global!.global,
        statistics: statistics!.statistics,
      })),
    ]);
    return {
      ...data,
      shareCard: page.shareCard,
      realm: deps.realm,
      paths: address?.paths ?? data.paths,
      reader,
      page: page.page,
      frame,
      relations,
      reactions,
      ratings,
      tabs: subjectTabs(page.page),
    };
  },
  head: ({ loaderData, match }) =>
    loaderData
      ? subjectHead(loaderData.page, {
          ...pageHeadContext(match.pathname),
          ...(loaderData.paths ? { paths: loaderData.paths } : {}),
          shareCard: loaderData.shareCard,
          realm: loaderData.realm,
          ...(loaderData.frame.label ? { typeLabel: loaderData.frame.label } : {}),
          ...(loaderData.frame.schemaOrgType ? { schemaOrgType: loaderData.frame.schemaOrgType } : {}),
          ...(loaderData.ratings.figure.kind === 'ready'
            ? { ratings: { figure: loaderData.ratings.figure.value } }
            : {}),
        })
      : { meta: [{ title: m.not_found_heading() }] },
  component: SubjectRoute,
});

function SubjectRoute() {
  return <SubjectOverview data={Route.useLoaderData()} search={Route.useSearch()} />;
}

/** The ordinary route's browser consumer, with its loader result kept at the existing BFF boundary. */
export function SubjectOverview({
  data,
  search,
}: {
  data: ReturnType<typeof Route.useLoaderData>;
  search: ReturnType<typeof Route.useSearch>;
}) {
  const { tabs, verification, reader: initialReader, page } = data;
  const { realm, slot, ratingFailure, labelResult, undoLabelId, undoAssignmentId, undoRevision, undoKey } = search;
  const browserSession = useSession();
  const { state: session } = browserSession;
  const readerKey = subjectReaderPartition(realm, initialReader, browserSession);
  const queryClient = useQueryClient();
  const locale = getLocale();
  const currentReader = useSubjectReaderRefresh(initialReader, readerKey);
  const id = page.subject!;
  const labelUndo =
    typeof undoLabelId === 'string' &&
    typeof undoAssignmentId === 'string' &&
    typeof undoRevision === 'number' &&
    Number.isSafeInteger(undoRevision) &&
    undoRevision > 0
      ? { labelId: undoLabelId, assignmentId: undoAssignmentId, revision: undoRevision }
      : undefined;
  const type = subjectPageType(page);
  const { data: frame } = useSuspenseQuery(type ? subjectFrameQuery(type, locale) : subjectFrameQuery('', locale));
  const { data: relations } = useSuspenseQuery(subjectRelationsQuery(pageRelationProperties(page), locale));
  const { data: publicReactions } = useSuspenseQuery(subjectReactionsQuery(id, locale));
  const [questionQuery, figureQuery, globalQuery, statisticsQuery] = useSuspenseQueries({
    queries: [
      subjectRatingQuery(id, locale, 'question'),
      subjectRatingQuery(id, locale, 'figure'),
      subjectRatingQuery(id, locale, 'global'),
      subjectRatingQuery(id, locale, 'statistics'),
    ],
  });
  const publicRatings: RatingSources = {
    question: questionQuery.data.question,
    figure: figureQuery.data.figure,
    global: globalQuery.data.global,
    statistics: statisticsQuery.data.statistics,
  };
  const retryRatingSource = (source: RatingSource) => {
    const request = {
      question: questionQuery,
      figure: figureQuery,
      global: globalQuery,
      statistics: statisticsQuery,
    }[source];
    void request.refetch().catch(() => {});
  };
  const { data: library } = useQuery({
    ...subjectLibraryQuery(id, locale, slot === 'collections', labelResult, labelUndo, subjectPageType(page)),
    enabled: session === 'signed-in',
  });
  const personal = useSubjectPersonalReader({
    subjectId: id,
    locale,
    view: 'overview',
    session: browserSession,
    enabled: currentReader,
    includeOwnRating: true,
  });
  const subjectReaction = useSubjectReactionReader({
    subjectId: id,
    locale,
    view: 'overview',
    session: browserSession,
    enabled: currentReader,
  });
  const reader = personal.reader;
  const ownRating = personal.ownRating;
  const reactions = publicReactions ? { ...publicReactions, value: subjectReaction.ownReaction?.value ?? null } : null;
  const ratings = publicRatings;
  const returnTo = contextHref(useLocation().publicHref.split(/[?#]/, 1)[0]!, realm);
  const nonce = useRouter().options.ssr?.nonce;
  if (!currentReader) return <PendingPage />;
  return (
    <RatingControlContext.Provider
      value={{
        subjectId: id,
        locale,
        returnTo,
        session,
        own: ownRating,
        ...(personal.binding ? { binding: personal.binding } : {}),
        ...(ratingFailure ? { failure: true } : {}),
      }}
    >
      <RatingsRecoveryContext.Provider value={retryRatingSource}>
        <RatingPopulationsContext.Provider
          value={
            ratings.question.kind === 'ready' ? (
              <SubjectRatingPopulations
                subjectId={id}
                question={ratings.question.value}
                locale={locale}
                session={browserSession}
                enabled={currentReader}
              />
            ) : null
          }
        >
          <RatingsContext.Provider value={ratings}>
            <SubjectPage
              page={page}
              curation={realm ? undefined : <SubjectCandidateCuration id={id} locale={locale} />}
              locale={getLocale()}
              messages={subjectPageMessages()}
              reader={reader}
              {...(frame.label ? { typeLabel: frame.label } : {})}
              {...(frame.ratio ? { ratio: frame.ratio } : {})}
              relations={relations}
              link={SubjectLink}
              tabs={tabs}
              tabLabels={viewTabLabels()}
              invitation={m.subject_empty()}
              {...(nonce !== undefined ? { nonce } : {})}
              renderJsonLd={false}
              actions={(subject) => (
                <SubjectHeaderActions
                  id={subject.id}
                  reactions={reactions}
                  signedIn={session === 'signed-in'}
                  personalReady={session !== 'signed-in' || subjectReaction.ready}
                  reactionOrigin={subjectReaction.origin}
                  reactionRecovery={{
                    failed: subjectReaction.recoveryFailed,
                    pending: subjectReaction.recoveryPending,
                    retry: subjectReaction.retryOwnReaction,
                  }}
                  onPersonalChange={async (kind) => {
                    if (!subjectReaction.origin.isCurrent()) return;
                    subjectReaction.applyMutation(kind);
                    if (!subjectReaction.origin.isCurrent()) return;
                    await queryClient.invalidateQueries({ queryKey: ['subject-reactions', id, locale] });
                  }}
                  returnTo={returnTo}
                  verification={verification}
                >
                  <SubjectLibrarySlot
                    subject={{ id: subject.id, type: subject.type, label: subjectPageTitle(page, subject.locale) }}
                    locale={subject.locale}
                    data={
                      library ?? {
                        session: 'signed-out',
                        csrfToken: null,
                        entryAvailable: false,
                        entry: null,
                        publicCollections: null,
                        publicCollectionsNext: null,
                        collectionsLoaded: false,
                        collections: null,
                        labels: null,
                      }
                    }
                    {...(library && undoKey ? { data: { ...library, labelUndoKey: undoKey } } : {})}
                  />
                </SubjectHeaderActions>
              )}
            />
          </RatingsContext.Provider>
        </RatingPopulationsContext.Provider>
      </RatingsRecoveryContext.Provider>
    </RatingControlContext.Provider>
  );
}
