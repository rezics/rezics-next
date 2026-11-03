import { prepareExposure } from '../../kernel/exposure';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { useQueryClient } from '@tanstack/react-query';
import { env } from 'cloudflare:workers';
import { useLayoutEffect, useRef } from 'react';
import { kernelClient } from '../../kernel/client';
import { readPersonalLibraryCurrent } from '../../library/personal-library-server';
import { PersonalLibraryCurrent } from '../../library/personal-library-current';
import { resolveShelfPresentation } from '../../library/shelf-preferences';
import { readCurrentShelfPreferences, ShelfPreferenceSnapshotOwner } from '../../settings/shelf-preferences-current';
import { sessionQuery, useSession } from '../../session/query';
import { CurrentLabelShelf } from '../../library/label-shelf-current';
import { loadCurrentLabelShelfPage, type CurrentLabelShelfData } from '../../library/label-shelf-read';
import { submitSubjectLabelForm } from '../../library/subject-slot-form-action';
import {
  ShelfAddressRecovery,
  ShelfStaleCursorRecovery,
  shelfPageResetCursor,
} from '../../library/shelf-address-recovery';
import type { SessionEnv } from '../../session/client';
import { shelfAddressIssues, shelfCursor, validateShelfSearch } from '../../library/shelf-params';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';

const routeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const readLabelShelf = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('labelId' in input) ||
      typeof input.labelId !== 'string' ||
      !routeId.test(input.labelId)
    )
      throw notFound();
    const value = input as Record<string, unknown>;
    const cursor = shelfCursor(value.cursor);
    if (value.cursor !== undefined && value.cursor !== '' && !cursor) throw notFound();
    const undo =
      typeof value.undoSubjectId === 'string' &&
      typeof value.undoAssignmentId === 'string' &&
      typeof value.undoLabelId === 'string' &&
      typeof value.undoRevision === 'number' &&
      value.undoRevision > 0
        ? {
            subjectId: value.undoSubjectId,
            assignmentId: value.undoAssignmentId,
            labelId: value.undoLabelId,
            revision: value.undoRevision,
          }
        : undefined;
    return {
      labelId: input.labelId,
      cursor,
      undo,
      labelResult: typeof value.labelResult === 'string' ? value.labelResult : undefined,
      undoKey: typeof value.undoKey === 'string' && routeId.test(value.undoKey) ? value.undoKey : undefined,
    };
  })
  .handler(async ({ data }): Promise<CurrentLabelShelfData> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadCurrentLabelShelfPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, {
      labelId: data.labelId,
      limit: 100,
      ...(data.cursor !== undefined ? { cursor: data.cursor } : {}),
      ...(data.undo !== undefined ? { undo: data.undo } : {}),
      ...(data.undoKey !== undefined ? { undoKey: data.undoKey } : {}),
      ...(data.labelResult !== undefined ? { labelResult: data.labelResult } : {}),
    });
  });

export const Route = createFileRoute('/library/')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.clone().formData();
        const result = await submitSubjectLabelForm(request);
        if (result instanceof Response) return result;
        const url = new URL(request.url);
        url.searchParams.delete('labelResult');
        url.searchParams.delete('undoLabelId');
        url.searchParams.delete('undoSubjectId');
        url.searchParams.delete('undoAssignmentId');
        url.searchParams.delete('undoRevision');
        url.searchParams.delete('undoKey');
        if (result.ok && form.get('intent') === 'unassign' && 'restoreRevision' in result && result.restoreRevision) {
          url.searchParams.set('labelResult', 'label-removed');
          url.searchParams.set('undoLabelId', String(form.get('labelId') ?? ''));
          url.searchParams.set('undoSubjectId', String(form.get('subjectId') ?? ''));
          url.searchParams.set('undoAssignmentId', String(form.get('assignmentId') ?? ''));
          url.searchParams.set('undoRevision', String(result.restoreRevision));
        } else if (!result.ok) {
          if (form.get('intent') === 'restore') {
            url.searchParams.set('undoLabelId', String(form.get('labelId') ?? ''));
            url.searchParams.set('undoSubjectId', String(form.get('subjectId') ?? ''));
            url.searchParams.set('undoAssignmentId', String(form.get('assignmentId') ?? ''));
            url.searchParams.set('undoRevision', String(form.get('revision') ?? ''));
            url.searchParams.set('undoKey', String(form.get('idempotencyKey') ?? ''));
          }
          const value =
            result.reason === 'capacity'
              ? 'label-capacity'
              : result.reason.startsWith('restore-')
                ? `label-${result.reason}`
                : result.reason;
          url.searchParams.set('labelResult', value);
        }
        return new Response(null, {
          status: 303,
          headers: { location: url.pathname + url.search, 'cache-control': 'private, no-store' },
        });
      },
    },
  },
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  validateSearch: (search: Record<string, unknown>) => ({
    ...validateShelfSearch(search),
    ...(typeof search.labelResult === 'string' ? { labelResult: search.labelResult } : {}),
    ...(typeof search.undoKey === 'string' ? { undoKey: search.undoKey } : {}),
    ...(typeof search.undoLabelId === 'string' ? { undoLabelId: search.undoLabelId } : {}),
    ...(typeof search.undoSubjectId === 'string' ? { undoSubjectId: search.undoSubjectId } : {}),
    ...(typeof search.undoAssignmentId === 'string' ? { undoAssignmentId: search.undoAssignmentId } : {}),
    ...(typeof search.undoRevision === 'number' ||
    (typeof search.undoRevision === 'string' && /^\d+$/.test(search.undoRevision))
      ? { undoRevision: Number(search.undoRevision) }
      : {}),
  }),
  // The router merges what the address says over what validation returns, so a value the validator dropped is still
  // there; reading through the validator again keeps only the documented values.
  // Columns, layout and size are display state; native reads and keysets depend only on the source below.
  loaderDeps: ({ search }) => {
    const { state, cursor, label, orderBy, direction, type } = validateShelfSearch(search);
    return {
      addressIssues: shelfAddressIssues(search),
      state,
      type,
      cursor,
      label,
      orderBy,
      direction,
      undoLabelId: typeof search.undoLabelId === 'string' ? search.undoLabelId : undefined,
      undoSubjectId: typeof search.undoSubjectId === 'string' ? search.undoSubjectId : undefined,
      undoAssignmentId: typeof search.undoAssignmentId === 'string' ? search.undoAssignmentId : undefined,
      undoRevision:
        typeof search.undoRevision === 'number' ||
        (typeof search.undoRevision === 'string' && /^\d+$/.test(search.undoRevision))
          ? Number(search.undoRevision)
          : undefined,
      labelResult: typeof search.labelResult === 'string' ? search.labelResult : undefined,
      undoKey: typeof search.undoKey === 'string' ? search.undoKey : undefined,
    };
  },
  loader: async ({ deps }) => {
    if (deps.addressIssues.length) return { addressRecovery: deps.addressIssues };
    if (deps.label) {
      const [page, shelfSnapshot] = await Promise.all([
        readLabelShelf({
          data: {
            labelId: deps.label,
            cursor: deps.cursor,
            undoLabelId: deps.undoLabelId,
            undoSubjectId: deps.undoSubjectId,
            undoAssignmentId: deps.undoAssignmentId,
            undoRevision: deps.undoRevision,
            undoKey: deps.undoKey,
            labelResult: deps.labelResult,
          },
        }),
        readCurrentShelfPreferences(),
      ]);
      return { ...page, shelfSnapshot };
    }
    const requested = {
      ...(deps.state ? { state: deps.state } : {}),
      ...(deps.type ? { type: deps.type } : {}),
      ...(deps.cursor ? { cursor: deps.cursor } : {}),
      ...(deps.orderBy ? { orderBy: deps.orderBy } : {}),
      ...(deps.direction ? { direction: deps.direction } : {}),
    };
    const shelfSnapshot = await readCurrentShelfPreferences();
    const resolved = resolveShelfPresentation(requested, shelfSnapshot.shelf ?? undefined);
    const page = await readPersonalLibraryCurrent({
      data: {
        orderBy: resolved.search.orderBy,
        direction: resolved.search.direction,
        ...(resolved.search.state ? { state: resolved.search.state } : {}),
        ...(resolved.search.type ? { type: resolved.search.type } : {}),
        ...(resolved.search.cursor ? { cursor: resolved.search.cursor } : {}),
      },
    });
    return { ...page, shelfSnapshot };
  },
  head: ({ match, loaderData }) =>
    pageHead(
      {
        title: loaderData && 'label' in loaderData ? loaderData.label.name : m.library_heading(),
        robots: 'noindex, nofollow',
      },
      pageHeadContext(match.pathname),
    ),
  component: LibraryRoute,
});

function LibraryRoute() {
  const rawSearch = Route.useSearch();
  const search = validateShelfSearch(rawSearch);
  const data = Route.useLoaderData();
  const snapshot = 'shelfSnapshot' in data ? data.shelfSnapshot : undefined;
  const locale = getLocale();
  const viewer = useSession();
  const queryClient = useQueryClient();
  const shelfOwner = useRef<ShelfPreferenceSnapshotOwner | null>(null);
  shelfOwner.current ??= new ShelfPreferenceSnapshotOwner();
  const owner = shelfOwner.current;
  useLayoutEffect(() => {
    const observe = () => {
      const query = queryClient.getQueryState(sessionQuery.queryKey);
      if (query?.status === 'error') owner.retire();
      else if (query?.status === 'success' && query.data) owner.observe(query.data);
      else if (query?.status === 'pending') owner.observe({ state: 'unknown', subject: null, csrfToken: null });
    };
    observe();
    return queryClient.getQueryCache().subscribe(({ query, type }) => {
      if (query.queryKey.length !== 1 || query.queryKey[0] !== sessionQuery.queryKey[0]) return;
      if (type === 'removed') owner.retire();
      else observe();
    });
  }, [owner, queryClient, snapshot?.generation]);
  if ('addressRecovery' in data)
    return <ShelfAddressRecovery locale={locale} search={rawSearch} issues={data.addressRecovery} />;
  const shelf = owner.resolve(snapshot, viewer);
  const presentation = resolveShelfPresentation(search, shelf);
  if (!('page' in data))
    return (
      <>
        {search.cursor && shelfPageResetCursor(data) ? (
          <ShelfStaleCursorRecovery locale={locale} search={rawSearch} />
        ) : null}
        <CurrentLabelShelf initial={data} locale={locale} display={presentation.display} read={readLabelShelf} />
      </>
    );
  return (
    <>
      {search.cursor && shelfPageResetCursor(data) ? (
        <ShelfStaleCursorRecovery locale={locale} search={rawSearch} />
      ) : null}
      <PersonalLibraryCurrent
        initial={data}
        search={presentation.search}
        locale={locale}
        display={presentation.display}
      />
    </>
  );
}
