import { createFileRoute, notFound, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { useQuery, useSuspenseQuery, useQueryClient } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { isView } from '@rezics/composition';
import { SubjectPage, pageRelationProperties, subjectPageTitle, subjectPageType } from '../../features/pages/subject';
import { subjectHead } from '../../features/pages/subject-head';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../../features/pages/route-support';
import { subjectTabs } from '../../features/pages/views';
import { SubjectHeaderActions } from '../../features/pages/subject-reactions-view';
import { RatingControlContext, RatingsContext } from '../../features/pages/subject-ratings-view';
import { postSubjectRatingForm } from '../../features/pages/rating-actions';
import {
  subjectFrameQuery,
  subjectLibraryQuery,
  subjectOwnRatingQuery,
  subjectOwnReactionQuery,
  subjectCanonicalQuery,
  keepSearch,
  subjectPageQuery,
  subjectRatingQuery,
  subjectReaderQuery,
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
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    const client = kernelClient(data.locale);
    const canonical = await loadSubject(client, data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug || canonical.value.href.includes('/@'))
      throw redirect({ href: keepSearch(subjectUrlForView(canonical.value, data.view), data.search), statusCode: 301 });

    const config = env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SCRIPT_URL?: string };
    const verification = {
      sitekey: config.TURNSTILE_SITE_KEY ?? '',
      scriptUrl:
        (import.meta.env.DEV && config.TURNSTILE_SCRIPT_URL) ||
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    };
    return {
      verification,
      paths: canonical.value.paths,
    };
  });

export const Route = createFileRoute('/subjects/$id_/$slug')({
  staticData: { publicCache: true },
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
          ['assign-by-name', 'unassign', 'restore'].includes(intents[0])
            ? intents[0]
            : null;
        if (intent) {
          const result = await submitSubjectLabelForm(request);
          const url = new URL(request.url);
          url.searchParams.delete('labelResult');
          url.searchParams.delete('undoLabelId');
          url.searchParams.delete('undoAssignmentId');
          url.searchParams.delete('undoRevision');
          url.searchParams.delete('ratingFailure');
          if (result.ok && intent === 'unassign' && result.restoreRevision !== undefined) {
            url.searchParams.set('labelResult', 'label-removed');
            url.searchParams.set('undoLabelId', String(fields?.get('labelId') ?? ''));
            url.searchParams.set('undoAssignmentId', String(fields?.get('assignmentId') ?? ''));
            url.searchParams.set('undoRevision', String(result.restoreRevision));
          } else if (!result.ok) {
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
    slot?: 'collections';
    slotResult?: string;
    ratingFailure?: true;
    labelResult?: string;
    undoLabelId?: string;
    undoAssignmentId?: string;
    undoRevision?: number;
  } => ({
    ...(search.slot === 'collections' ? { slot: 'collections' as const } : {}),
    ...(typeof search.slotResult === 'string' ? { slotResult: search.slotResult } : {}),
    ...(search.ratingFailure === '1' ? { ratingFailure: true as const } : {}),
    ...(typeof search.labelResult === 'string' ? { labelResult: search.labelResult } : {}),
    ...(typeof search.undoLabelId === 'string' ? { undoLabelId: search.undoLabelId } : {}),
    ...(typeof search.undoAssignmentId === 'string' ? { undoAssignmentId: search.undoAssignmentId } : {}),
    ...(typeof search.undoRevision === 'number' ||
    (typeof search.undoRevision === 'string' && /^\d+$/.test(search.undoRevision))
      ? { undoRevision: Number(search.undoRevision) }
      : {}),
  }),
  loaderDeps: ({ search }) => ({
    slot: search.slot,
    slotResult: search.slotResult,
    labelResult: search.labelResult,
    undoLabelId: search.undoLabelId,
    undoAssignmentId: search.undoAssignmentId,
    undoRevision: search.undoRevision,
  }),
  loader: async ({ params, deps, location, context }) => {
    const data = await readSubject({
      data: {
        id: params.id,
        slug: params.slug,
        locale: getLocale(),
        search: location.searchStr,
        loadCollections: deps.slot === 'collections',
        slotResult: deps.slotResult,
        view: isView(params.slug) && params.slug !== 'overview' ? params.slug : undefined,
      },
    });
    const view = isView(params.slug) && params.slug !== 'overview' ? params.slug : 'overview';
    const pageQuery = subjectPageQuery(params.id, getLocale(), view);
    const page = await context.queryClient.ensureQueryData(pageQuery);
    if (page.kind === 'redirect') {
      const survivor = await context.queryClient.ensureQueryData(subjectCanonicalQuery(page.id, getLocale()));
      if (survivor.kind === 'missing') throw notFound();
      throw redirect({
        href: keepSearch(subjectUrlForView(survivor.value, view), location.searchStr),
        statusCode: 301,
      });
    }
    if (page.kind !== 'page') throw notFound();
    const type = subjectPageType(page.page);
    const [frame, relations, reactions, ratings] = await Promise.all([
      type
        ? context.queryClient.ensureQueryData(subjectFrameQuery(type, getLocale()))
        : Promise.resolve({ label: undefined, ratio: undefined, schemaOrgType: undefined }),
      context.queryClient.ensureQueryData(subjectRelationsQuery(pageRelationProperties(page.page), getLocale())),
      context.queryClient.ensureQueryData(subjectReactionsQuery(params.id, getLocale())),
      context.queryClient.ensureQueryData(subjectRatingQuery(params.id, getLocale())),
    ]);
    return { ...data, page: page.page, frame, relations, reactions, ratings, tabs: subjectTabs(page.page) };
  },
  head: ({ loaderData, match }) =>
    loaderData
      ? subjectHead(loaderData.page, {
          ...pageHeadContext(match.pathname),
          paths: loaderData.paths,
          ...(loaderData.frame.label ? { typeLabel: loaderData.frame.label } : {}),
          ...(loaderData.frame.schemaOrgType ? { schemaOrgType: loaderData.frame.schemaOrgType } : {}),
          ...(loaderData.ratings ? { ratings: loaderData.ratings } : {}),
        })
      : { meta: [{ title: m.not_found_heading() }] },
  component: SubjectRoute,
});

function SubjectRoute() {
  const { tabs, verification } = Route.useLoaderData();
  const { slot, ratingFailure, labelResult, undoLabelId, undoAssignmentId, undoRevision } = Route.useSearch();
  const { state: session } = useSession();
  const queryClient = useQueryClient();
  const locale = getLocale();
  const { id: routeId, slug } = Route.useParams();
  const view = isView(slug) && slug !== 'overview' ? slug : 'overview';
  const { data: loaded } = useSuspenseQuery(subjectPageQuery(routeId, locale, view));
  const page = loaded.kind === 'page' ? loaded.page : undefined;
  if (!page) throw notFound();
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
  const { data: publicRatings } = useSuspenseQuery(subjectRatingQuery(id, locale));
  const { data: library } = useQuery({
    ...subjectLibraryQuery(id, locale, slot === 'collections', labelResult, labelUndo),
    enabled: session === 'signed-in',
  });
  const { data: reader } = useQuery({ ...subjectReaderQuery(id, locale), enabled: session === 'signed-in' });
  const { data: ownReaction } = useQuery({ ...subjectOwnReactionQuery(id, locale), enabled: session === 'signed-in' });
  const { data: ownRating } = useQuery({ ...subjectOwnRatingQuery(id, locale), enabled: session === 'signed-in' });
  const reactions = publicReactions
    ? { ...publicReactions, value: session === 'signed-in' ? (ownReaction ?? null) : null }
    : null;
  const ratings = publicRatings
    ? { ...publicRatings, own: session === 'signed-in' && ownRating?.kind === 'ready' ? ownRating.units : null }
    : null;
  const returnTo = useLocation().publicHref.split(/[?#]/, 1)[0]!;
  const nonce = useRouter().options.ssr?.nonce;
  return (
    <RatingControlContext.Provider
      value={{
        subjectId: id,
        locale,
        returnTo,
        session,
        own: ownRating,
        ...(ratingFailure ? { failure: true } : {}),
      }}
    >
      <RatingsContext.Provider value={ratings}>
        <SubjectPage
          page={page}
          locale={getLocale()}
          messages={subjectPageMessages()}
          {...(reader ? { reader } : {})}
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
              personalReady={session !== 'signed-in' || ownReaction !== undefined}
              onPersonalChange={async () => {
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ['subject-own-reaction', id, locale] }),
                  queryClient.invalidateQueries({ queryKey: ['subject-reactions', id, locale] }),
                ]);
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
              />
            </SubjectHeaderActions>
          )}
        />
      </RatingsContext.Provider>
    </RatingControlContext.Provider>
  );
}
