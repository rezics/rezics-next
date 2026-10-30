import { prepareExposure } from '../../kernel/exposure';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { LabelShelfPage, PersonalLibraryPage } from '../../library/entries-page';
import { readPersonalLibrary } from '../../library/entries-actions';
import { loadLabelShelfPage, type LabelShelfPageData } from '../../library/label-shelf-read';
import { submitSubjectLabelForm } from '../../library/subject-slot-form-action';
import type { SessionEnv } from '../../session/client';
import { shelfDisplay, validateShelfSearch } from '../../library/shelf-params';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { readContinueEntries } from '../../library/continue-read';
import type { PersonalLibraryView } from '../../library/entries-read';

const routeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    const cursor = typeof value.cursor === 'string' && value.cursor.length > 0 ? value.cursor : undefined;
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
    };
  })
  .handler(async ({ data }): Promise<LabelShelfPageData> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadLabelShelfPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, {
      labelId: data.labelId,
      limit: 100,
      ...(data.cursor !== undefined ? { cursor: data.cursor } : {}),
      ...(data.undo !== undefined ? { undo: data.undo } : {}),
      ...(data.labelResult !== undefined ? { labelResult: data.labelResult } : {}),
    });
  });

export const Route = createFileRoute('/library/')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.clone().formData();
        const result = await submitSubjectLabelForm(request);
        const url = new URL(request.url);
        url.searchParams.delete('labelResult');
        url.searchParams.delete('undoLabelId');
        url.searchParams.delete('undoSubjectId');
        url.searchParams.delete('undoAssignmentId');
        url.searchParams.delete('undoRevision');
        if (result.ok && form.get('intent') === 'unassign' && 'restoreRevision' in result && result.restoreRevision) {
          url.searchParams.set('labelResult', 'label-removed');
          url.searchParams.set('undoLabelId', String(form.get('labelId') ?? ''));
          url.searchParams.set('undoSubjectId', String(form.get('subjectId') ?? ''));
          url.searchParams.set('undoAssignmentId', String(form.get('assignmentId') ?? ''));
          url.searchParams.set('undoRevision', String(result.restoreRevision));
        } else if (!result.ok) {
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
  loaderDeps: ({ search }) => {
    const { state, cursor, label } = validateShelfSearch(search);
    return {
      state,
      cursor,
      label,
      undoLabelId: typeof search.undoLabelId === 'string' ? search.undoLabelId : undefined,
      undoSubjectId: typeof search.undoSubjectId === 'string' ? search.undoSubjectId : undefined,
      undoAssignmentId: typeof search.undoAssignmentId === 'string' ? search.undoAssignmentId : undefined,
      undoRevision:
        typeof search.undoRevision === 'number' ||
        (typeof search.undoRevision === 'string' && /^\d+$/.test(search.undoRevision))
          ? Number(search.undoRevision)
          : undefined,
      labelResult: typeof search.labelResult === 'string' ? search.labelResult : undefined,
    };
  },
  loader: async ({ deps }) => {
    if (deps.label)
      return readLabelShelf({
        data: {
          labelId: deps.label,
          cursor: deps.cursor,
          undoLabelId: deps.undoLabelId,
          undoSubjectId: deps.undoSubjectId,
          undoAssignmentId: deps.undoAssignmentId,
          undoRevision: deps.undoRevision,
          labelResult: deps.labelResult,
        },
      });
    const [page, continueEntries] = await Promise.all([
      readPersonalLibrary({
        data: { ...(deps.state ? { state: deps.state } : {}), ...(deps.cursor ? { cursor: deps.cursor } : {}) },
      }),
      readContinueEntries(),
    ]);
    return { page, continueEntries };
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
  const search = validateShelfSearch(Route.useSearch());
  const data = Route.useLoaderData();
  if (search.label)
    return <LabelShelfPage page={data as LabelShelfPageData} locale={getLocale()} display={shelfDisplay(search)} />;
  return (
    <PersonalLibraryPage
      page={(data as { page: PersonalLibraryView }).page}
      continueEntries={(data as { continueEntries: Awaited<ReturnType<typeof readContinueEntries>> }).continueEntries}
      locale={getLocale()}
      display={shelfDisplay(search)}
      {...(search.cursor ? { cursor: search.cursor } : {})}
    />
  );
}
