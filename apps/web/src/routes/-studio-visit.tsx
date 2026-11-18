import { useEffect, useMemo, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  createPostDocumentPort,
  createStudioAccountPort,
  hostedFailure,
  HostedBookInventory,
  HostedRootAppendEntry,
  HostedDraftPointEntry,
  HostedReleasePreparationEntry,
  releaseCopy,
  HostedInventoryVisit,
  HostedDraftPicker,
  hostedBookNative,
  openHostedStudio,
  StudioWorkspace,
  type ExactDocument,
  type StudioDocument,
  type StudioInput,
  type StudioResult,
  type StudioSelection,
  type HostedOwnedBook,
  type HostedStudioInput,
  type HostedStudioBinding,
  type HostedTarget,
} from '../studio';
import {
  ownDraftBrowserWritingReader,
  ownDraftNativeCommandTransport,
  ownDraftNativeReader,
  useOwnDraftVisit,
} from '../threads';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref, type Locale } from '../paraglide/runtime.js';
import { historicalReaderSource, type HistoricalReaderSource } from '../threads/historical-reader-provenance';
import { hostedReleaseActivationTransport } from '../studio/hosted-release-activation-actions';
import { hostedOwnerBookHref } from '../studio/hosted-inventory';
import { StudioMessage, StudioPreparing } from './-studio-state';
import type { StudioSearch } from './studio';

export default function StudioVisit({
  search,
  owner,
  accountId,
  csrfToken,
  locale,
}: {
  search: StudioSearch;
  owner: HostedOwnedBook | undefined;
  accountId: string | null;
  csrfToken: string | null;
  locale: Locale;
}) {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<HistoricalReaderSource | null>(null);
  useEffect(() => {
    setSource(historicalReaderSource(queryClient));
  }, [queryClient, accountId]);

  if (owner) {
    return (
      <BookStudioEntry
        append={search.append === '1'}
        points={search.points === '1'}
        prepare={search.prepare === '1'}
        stageId={search.stageId ?? null}
        owner={owner}
        source={source}
        accountId={accountId}
        csrfToken={csrfToken}
        locale={locale}
      />
    );
  }
  if (search.books) {
    return <StudioBooksVisit source={source} accountId={accountId} cursor={search.cursor ?? null} locale={locale} />;
  }
  return (
    <StudioAccountVisit
      source={source}
      accountId={accountId}
      csrfToken={csrfToken}
      locale={locale}
      cursor={search.cursor ?? null}
      draftCursor={search.draftCursor ?? null}
      resumePostId={search.postId ?? null}
    />
  );
}

function StudioBooksVisit({
  source,
  accountId,
  cursor,
  locale,
}: {
  source: HistoricalReaderSource | null;
  accountId: string | null;
  cursor: string | null;
  locale: Locale;
}) {
  const [visit, setVisit] = useState<HostedInventoryVisit | null>(null);
  useEffect(() => {
    if (!source || !accountId) {
      setVisit(null);
      return;
    }
    const next = new HostedInventoryVisit(hostedBookNative, source, accountId, cursor);
    setVisit(next);
    void next.load();
    return next.dispose;
  }, [source, accountId, cursor]);
  return visit ? <HostedBookInventory visit={visit} locale={locale} /> : <StudioPreparing />;
}

type AccountWorkspaceState =
  | { state: 'loading'; cursor: string | null }
  | { state: 'failed'; cursor: string | null; message: string }
  | {
      state: 'ready';
      workspace: Parameters<typeof StudioWorkspace>[0];
      preparing: boolean;
      resumeIssue: string | null;
    };

function StudioAccountVisit({
  source,
  accountId,
  csrfToken,
  locale,
  cursor,
  draftCursor,
  resumePostId,
}: {
  source: HistoricalReaderSource | null;
  accountId: string | null | undefined;
  csrfToken: string | null;
  locale: Locale;
  cursor: string | null;
  draftCursor: string | null;
  resumePostId: string | null;
}) {
  const router = useRouter();
  const localWritingReader = useMemo(() => ownDraftBrowserWritingReader(() => window.localStorage), []);
  const visit = useOwnDraftVisit(ownDraftNativeReader, localWritingReader, ownDraftNativeCommandTransport, {
    scope: 'studio-account-drafts',
    source: 'content',
    address: '/studio',
  });
  const requestedCursor = draftCursor ?? cursor;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<AccountWorkspaceState | null>(null);
  useEffect(() => {
    if (!source || !accountId || !visit.active || visit.identity.accountId !== accountId) {
      setLoaded(null);
      return;
    }
    const controller = new AbortController();
    const origin = source.read();
    const isCurrent = () => {
      const now = source.read();
      return (
        !controller.signal.aborted &&
        visit.current() &&
        now.healthy &&
        now.sourceId === origin.sourceId &&
        now.generation === origin.generation &&
        now.state === 'signed-in' &&
        now.subject === accountId
      );
    };
    setLoaded({ state: 'loading', cursor: requestedCursor });
    void (async () => {
      const page = await visit.reader.list(
        {
          accountId,
          ...(requestedCursor === null ? {} : { cursor: requestedCursor }),
        },
        controller.signal,
      );
      if (!isCurrent()) return;
      if (typeof page === 'string') {
        const message =
          page === 'denied' ? m.own_drafts_denied({}, { locale }) : m.own_drafts_unavailable({}, { locale });
        setLoaded({ state: 'failed', cursor: requestedCursor, message });
        return;
      }
      if (page.viewer.accountId !== accountId || page.drafts.length > 20) {
        setLoaded({ state: 'failed', cursor: requestedCursor, message: m.own_drafts_unavailable({}, { locale }) });
        return;
      }
      const identity = { ...visit.identity, accountId, authnEpoch: page.viewer.authnEpoch };
      const port = createStudioAccountPort({
        identity,
        initialPage: page,
        reader: visit.reader,
        ...(visit.commands ? { commands: visit.commands } : {}),
        source,
        csrfToken,
        locale,
        isCurrent,
      });
      const documents: StudioDocument[] = page.drafts.map((entry) => ({
        postId: entry.id,
        title: entry.title ?? m.own_drafts_no_title({}, { locale }),
        revisionId: entry.revisionId,
        updatedAt: entry.savedAt,
        state: 'draft',
        openable: entry.kind === 'discussion' && entry.documentKind === 'opening',
      }));
      let initialSelection: StudioSelection | undefined;
      let resumeIssue: string | null = null;
      if (resumePostId) {
        const opened = await port.resume(resumePostId, controller.signal);
        if (opened.ok) initialSelection = opened.value;
        else resumeIssue = opened.error.message;
      }
      if (!isCurrent()) return;
      const input: StudioInput = {
        visitKey: JSON.stringify([
          accountId,
          page.viewer.authnEpoch,
          identity.callerEpoch,
          locale,
          requestedCursor,
          resumePostId,
        ]),
        projectId: accountId,
        title: m.own_drafts_title({}, { locale }),
        profile: { kind: 'articles', seriesTitle: null },
        documents: { items: documents, nextCursor: page.next },
        publications: { items: [], nextCursor: null },
        ...(initialSelection ? { initialSelection } : {}),
        canCreateDraft: Boolean(visit.commands),
        nativeDrafts: true,
        canPublish: Boolean(visit.commands),
      };
      setLoaded({
        state: 'ready',
        workspace: {
          input,
          port,
          bookStart: {
            native: hostedBookNative,
            source,
            viewer: page.viewer,
            isCurrent,
            navigate: (href) => {
              void router.navigate({ href: localizeHref(href, { locale }) });
            },
          },
        },
        preparing: page.state === 'preparing',
        resumeIssue,
      });
    })().catch(() => {
      if (isCurrent())
        setLoaded({ state: 'failed', cursor: requestedCursor, message: m.own_drafts_unavailable({}, { locale }) });
    });
    return () => controller.abort();
  }, [
    accountId,
    attempt,
    csrfToken,
    locale,
    requestedCursor,
    resumePostId,
    router,
    source,
    visit.active,
    visit.commands,
    visit.current,
    visit.identity,
    visit.reader,
  ]);

  return (
    <>
      {!visit.active || !source || !accountId ? <StudioPreparing /> : null}
      {loaded?.state === 'loading' ? <p role="status">{m.own_drafts_loading({}, { locale })}</p> : null}
      {loaded?.state === 'failed' ? (
        <section className="studio-stack" role="alert">
          <p>{loaded.message}</p>
          <Button type="button" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            {m.own_drafts_retry({}, { locale })}
          </Button>
        </section>
      ) : null}
      {loaded?.state === 'ready' ? (
        <>
          {loaded.preparing ? <p role="status">{m.own_drafts_preparing({}, { locale })}</p> : null}
          {loaded.resumeIssue ? <p role="alert">{loaded.resumeIssue}</p> : null}
          <StudioWorkspace {...loaded.workspace} />
        </>
      ) : null}
    </>
  );
}

function StudioResultMessage({ result }: { result: StudioResult<unknown> | null }) {
  return result ? (
    <StudioMessage
      message={result.ok ? m.studio_workspace_open_failed({}, { locale: getLocale() }) : result.error.message}
    />
  ) : (
    <StudioPreparing />
  );
}

function documentRow(selection: StudioSelection, fallbackState: StudioDocument['state'] = 'draft'): StudioDocument {
  return {
    postId: selection.revision.exact.postId,
    title: selection.revision.title,
    revisionId: selection.revision.exact.revisionId,
    updatedAt: selection.revision.savedAt,
    state: selection.visibility ?? fallbackState,
  };
}

function BookStudioEntry({
  append,
  points,
  prepare,
  stageId,
  ...props
}: Parameters<typeof BookStudioVisit>[0] & {
  append: boolean;
  points: boolean;
  prepare: boolean;
  stageId: string | null;
}) {
  if (prepare)
    return <HostedReleasePreparationEntry {...props} stageId={stageId} activation={hostedReleaseActivationTransport} />;
  if (points) return <HostedDraftPointEntry {...props} />;
  if (append) return <HostedRootAppendEntry {...props} />;
  return <BookStudioVisit {...props} />;
}

function BookPublicationTools({ owner, locale }: { owner: HostedOwnedBook; locale: Locale }) {
  return (
    <nav className="studio-action-row">
      <a
        className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        href={localizeHref(`${hostedOwnerBookHref(owner.item, owner.viewer)}&prepare=1`, { locale: locale })}
      >
        {releaseCopy[locale].entry}
      </a>
    </nav>
  );
}

function BookStudioVisit({
  owner,
  source,
  accountId,
  csrfToken,
  locale,
}: {
  owner: HostedOwnedBook;
  source: HistoricalReaderSource | null;
  accountId: string | null | undefined;
  csrfToken: string | null;
  locale: Locale;
}) {
  const book = owner.item;
  const [workspace, setWorkspace] = useState<Parameters<typeof StudioWorkspace>[0] | null>(null);
  const [result, setResult] = useState<StudioResult<unknown> | null>(null);
  useEffect(() => {
    setWorkspace(null);
    setResult(null);
    if (!source || !accountId) return;
    if (owner.viewer.accountId !== accountId) {
      setResult(hostedFailure('denied', m.studio_books_ended({}, { locale })));
      return;
    }
    const controller = new AbortController();
    const origin = source.read();
    const unsubscribe = source.subscribe(() => {
      if (isCurrent()) return;
      controller.abort();
      setWorkspace(null);
      setResult(hostedFailure('denied', m.studio_books_ended({}, { locale })));
    });
    let binding: HostedStudioBinding | null = null;
    let picker: HostedDraftPicker | null = null;
    const attachedTarget = (postId: string) =>
      binding?.book.chapterTargets().find((target) => target.postId === postId);
    const isCurrent = () => {
      const now = source.read();
      return (
        !controller.signal.aborted &&
        now.healthy &&
        now.sourceId === origin.sourceId &&
        now.generation === origin.generation &&
        now.state === 'signed-in' &&
        now.subject === accountId
      );
    };
    const documents = createPostDocumentPort({
      projectId: book.catalogueId,
      accountId,
      locale,
      source,
      csrfToken,
      isCurrent,
      admitsPost: (postId) =>
        postId === book.catalogueId || Boolean(attachedTarget(postId)) || Boolean(picker?.admitsPost(postId)),
    });
    const resolveTarget = async (document: ExactDocument, signal: AbortSignal): Promise<StudioResult<HostedTarget>> => {
      if (signal.aborted || !isCurrent()) return hostedFailure('denied', m.studio_workspace_ended({}, { locale }));
      const threadId = document.postId === book.catalogueId ? book.threadId : attachedTarget(document.postId)?.threadId;
      const target = threadId ? { threadId, ...document } : picker?.target(document);
      return target
        ? { ok: true, value: target }
        : hostedFailure('unavailable', m.studio_workspace_open_saved({}, { locale }));
    };
    const run = async () => {
      let initialSelection: StudioSelection | undefined;
      const opened = await documents.open({ projectId: book.catalogueId, postId: book.catalogueId }, controller.signal);
      if (opened.ok) initialSelection = opened.value;
      else if (!isCurrent()) return;
      const document = initialSelection
        ? documentRow(initialSelection, book.postVisibility)
        : {
            postId: book.catalogueId,
            title: book.title ?? '',
            revisionId: book.postRevisionId,
            updatedAt: book.createdAt,
            state: book.postVisibility,
          };
      const input: HostedStudioInput = {
        visitKey: JSON.stringify([accountId, origin.generation, book.catalogueId]),
        projectId: book.catalogueId,
        title:
          initialSelection?.revision.title.trim() ||
          book.title?.trim() ||
          m.studio_workspace_book_title({}, { locale }),
        documents: { items: [document], nextCursor: null },
        publications: { items: [], nextCursor: null },
        ...(initialSelection ? { initialSelection } : {}),
        canCreateDraft: false,
      };
      const bound = await openHostedStudio(
        {
          catalogueId: book.catalogueId,
          accountId,
          input,
          documents: {
            ...documents,
            open: (request, signal) =>
              picker?.hasEntry(request.postId)
                ? picker.openDocument(request.postId, signal)
                : documents.open(request, signal),
          },
          resolveTarget,
          isCurrent,
          owner,
          ...(csrfToken ? { sourceConsent: { source, csrfToken } } : {}),
        },
        controller.signal,
      );
      if (!isCurrent()) return;
      setResult(bound);
      if (!bound.ok) return;
      binding = bound.value;
      picker = new HostedDraftPicker({
        viewer: binding.viewer,
        source,
        reader: ownDraftNativeReader,
        locale,
        isCurrent,
        readDocument: (postId, signal) => documents.open({ projectId: book.catalogueId, postId }, signal),
      });
      setWorkspace({ ...binding.workspace, draftPicker: picker });
    };
    void run();
    return () => {
      unsubscribe();
      controller.abort();
      picker?.dispose();
    };
  }, [owner, book, source, accountId, csrfToken, locale]);
  if (workspace)
    return (
      <div className="mx-auto w-full max-w-screen-2xl px-4 py-6">
        <StudioWorkspace {...workspace} publicationTools={<BookPublicationTools owner={owner} locale={locale} />} />
      </div>
    );
  if (!result || result.ok || result.error.kind !== 'unavailable') return <StudioResultMessage result={result} />;
  return (
    <>
      <StudioResultMessage result={result} />
      <section className="mx-auto w-full max-w-4xl px-4 pb-8">
        <a
          className="studio-toc-open"
          href={localizeHref(`${hostedOwnerBookHref(book, owner.viewer)}&points=1`, { locale })}
        >
          {m.studio_draft_point_entry({}, { locale })}
        </a>
        <BookPublicationTools owner={owner} locale={locale} />
      </section>
    </>
  );
}
