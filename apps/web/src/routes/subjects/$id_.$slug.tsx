import {
  subjectGraphVisitReturn,
  subjectRouteSearchLimit,
  subjectVisitReturn,
} from '../../features/pages/subject-visit-navigation';
import { contextSubjectAddress } from '../../features/pages/context-subject';
import { validatePageBoard, validatePageNode, validatePageRealm } from '../../features/pages/view-cursor';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { isView } from '@rezics/composition';
import { subjectPageType } from '../../features/pages/subject-page-summary';
import { catalogueFileSourceId } from '../../features/catalogue/catalogue-file-reader/navigation';
import { subjectHead } from '../../features/pages/subject-head';
import { subjectTabs } from '../../features/pages/views';
import { postSubjectRatingForm, type SubjectRatingFormHint } from '../../features/pages/rating-actions';
import {
  subjectFrameQuery,
  subjectCanonicalQuery,
  subjectRequestReader,
  subjectKernelClient,
  canonicalRedirect,
  accountHref,
  keepSearch,
  subjectPageQuery,
  subjectUrlForView,
} from '../../features/pages/subject-queries';
import { submitSubjectLabelForm } from '../../library/subject-slot-form-action';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../../session/client';
import { pageHeadContext } from '../../shell/head-context';
import { awaitSubjectRoute, readSubjectCanonicalQuery } from '../../features/pages/subject-canonical-lifetime';
import { SubjectOverview } from './-overview';

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
      input.search.length > subjectRouteSearchLimit(input.search) ||
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
    const signal = getRequest().signal;
    signal.throwIfAborted();
    let paths;
    if (!data.realm) {
      const { client } = await subjectKernelClient(data.locale, undefined, undefined, signal);
      signal.throwIfAborted();
      const { loadContextSubject } = await import('../../features/pages/context-subject');
      signal.throwIfAborted();
      const canonical = await loadContextSubject(client, data.id, data.locale, { signal });
      signal.throwIfAborted();
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
          url.searchParams.delete('ratingResult');
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
        url.searchParams.delete('ratingFailure');
        url.searchParams.delete('ratingResult');
        url.searchParams.set('ratingResult', result);
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
    board?: string | undefined;
    via?: string | undefined;
    recipeReturn?: string | undefined;
    node?: string | undefined;
    streamProperty?: string | undefined;
    streamDirection?: 'forward' | 'inverse' | undefined;
    fileSource?: string | undefined;
    slot?: 'collections';
    slotResult?: string;
    ratingFailure?: true;
    ratingResult?: SubjectRatingFormHint;
    labelResult?: string;
    undoLabelId?: string;
    undoAssignmentId?: string;
    undoRevision?: number;
    undoKey?: string;
  } => {
    const node = validatePageNode(search.node);
    const streamProperty = search.streamProperty;
    const streamDirection = search.streamDirection;
    if (
      (streamProperty !== undefined &&
        (typeof streamProperty !== 'string' ||
          !streamProperty.trim() ||
          streamProperty.length > 256 ||
          /[\u0000-\u001f\u007f]/u.test(streamProperty))) ||
      (streamDirection !== undefined && streamDirection !== 'forward' && streamDirection !== 'inverse') ||
      ((streamProperty !== undefined || streamDirection !== undefined) &&
        (node === undefined || streamProperty === undefined || streamDirection === undefined))
    )
      throw notFound();
    return {
      realm: validatePageRealm(search.realm),
      board: validatePageBoard(search.board),
      via: subjectVisitReturn(search.via ?? subjectGraphVisitReturn(search.returnTo, getLocale()), getLocale()),
      ...(typeof search.recipeReturn === 'string' && search.recipeReturn.length <= 8192
        ? { recipeReturn: search.recipeReturn }
        : {}),
      ...(node ? { node } : {}),
      ...(typeof streamProperty === 'string' ? { streamProperty } : {}),
      ...(streamDirection === 'forward' || streamDirection === 'inverse' ? { streamDirection } : {}),
      ...(catalogueFileSourceId(search.fileSource) ? { fileSource: catalogueFileSourceId(search.fileSource) } : {}),
      ...(search.slot === 'collections' ? { slot: 'collections' as const } : {}),
      ...(typeof search.slotResult === 'string' ? { slotResult: search.slotResult } : {}),
      ...(search.ratingFailure === '1' ? { ratingFailure: true as const } : {}),
      ...(search.ratingResult === 'successful' ||
      search.ratingResult === 'rejected' ||
      search.ratingResult === 'stale' ||
      search.ratingResult === 'uncertain'
        ? { ratingResult: search.ratingResult }
        : {}),
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
    };
  },
  loaderDeps: ({ search }) => ({
    realm: search.realm,
    board: search.board,
    via: search.via,
    recipeReturn: search.recipeReturn,
    node: search.node,
    streamProperty: search.streamProperty,
    streamDirection: search.streamDirection,
    slot: search.slot,
    slotResult: search.slotResult,
    labelResult: search.labelResult,
    undoLabelId: search.undoLabelId,
    undoAssignmentId: search.undoAssignmentId,
    undoRevision: search.undoRevision,
  }),
  loader: async ({ params, deps, location, context, abortController }) => {
    const signal = abortController.signal;
    const reader = await awaitSubjectRoute(signal, () =>
      subjectRequestReader({ data: { realm: deps.realm, board: deps.board }, signal }),
    );
    const data = await awaitSubjectRoute(signal, () =>
      readSubject({
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
        signal,
      }),
    );
    const view = 'overview' as const;
    // Fetch current native proof for both the reading and its permitted share-card projection.
    const pageQuery = subjectPageQuery(params.id, getLocale(), view, deps.realm, reader, deps.board);
    const page = await awaitSubjectRoute(signal, () => context.queryClient.fetchQuery(pageQuery));
    signal.throwIfAborted();
    if (page.kind === 'redirect') {
      if (page.target === 'account')
        throw redirect(canonicalRedirect(accountHref(getLocale(), page.id, view), location.searchStr, location.hash));
      const survivor = await readSubjectCanonicalQuery(
        context.queryClient,
        subjectCanonicalQuery(page.id, getLocale(), deps.realm, reader),
        signal,
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
    const typeData = await awaitSubjectRoute(signal, () =>
      context.queryClient.ensureQueryData(subjectFrameQuery(type ?? '', getLocale())),
    );
    return {
      ...data,
      shareCard: page.shareCard,
      realm: deps.realm,
      paths: address?.paths ?? data.paths,
      reader,
      page: page.page,
      communityQueryKey: pageQuery.queryKey,
      tabs: subjectTabs(page.page),
      type: typeData,
    };
  },
  head: ({ loaderData, match }) =>
    loaderData
      ? subjectHead(loaderData.page, {
          ...pageHeadContext(match.pathname),
          ...(loaderData.paths ? { paths: loaderData.paths } : {}),
          shareCard: loaderData.shareCard,
          realm: loaderData.realm,
          ...(loaderData.type.label ? { typeLabel: loaderData.type.label } : {}),
          ...(loaderData.type.schemaOrgType ? { schemaOrgType: loaderData.type.schemaOrgType } : {}),
        })
      : { meta: [{ title: m.not_found_heading() }] },
  component: SubjectRoute,
});

function SubjectRoute() {
  return <SubjectOverview data={Route.useLoaderData()} search={Route.useSearch()} />;
}
