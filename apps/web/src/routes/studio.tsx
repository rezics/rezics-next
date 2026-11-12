import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import {
  createPostDocumentPort,
  createStudioAccountPort,
  hostedFailure,
  hostedId,
  listHostedBooks,
  openHostedStudio,
  readOwnedHostedBook,
  StudioWorkspace,
  type ExactDocument,
  type StudioDocument,
  type StudioInput,
  type StudioResult,
  type StudioSelection,
  type HostedOwnerBook,
  type HostedOwnerInventory,
  type HostedStudioInput,
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
import { useSession } from '../session/query';
import { requireSignedIn } from '../session/guard';
import { pageHead } from '../shell/head';
import { pageHeadContext } from '../shell/head-context';
import { getLocale, localizeHref, type Locale } from '../paraglide/runtime.js';
import { historicalReaderSource, type HistoricalReaderSource } from '../threads/historical-reader-provenance';

const searchSchema = v.pipe(
  v.strictObject({
    catalogueId: v.optional(hostedId),
    postId: v.optional(hostedId),
    books: v.optional(v.literal('1')),
    cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
    draftCursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(32768))),
  }),
  v.check((value) => !(value.catalogueId && value.postId) && !(value.books && (value.catalogueId || value.postId))),
);

export const Route = createFileRoute('/studio')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: unknown) => v.parse(searchSchema, search),
  loaderDeps: ({ search }) => ({
    catalogueId: search.catalogueId ?? null,
    postId: search.postId ?? null,
    books: search.books ?? null,
    cursor: search.cursor ?? null,
    draftCursor: search.draftCursor ?? null,
  }),
  loader: ({ deps }) =>
    deps.catalogueId
      ? readOwnedHostedBook({ data: { catalogueId: deps.catalogueId } })
      : deps.books
        ? listHostedBooks({ data: { ...(deps.cursor ? { cursor: deps.cursor } : {}) } })
        : Promise.resolve(null),
  head: ({ match }) => pageHead({ title: 'Studio', robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: StudioRoute,
});

type InventoryRead = Awaited<ReturnType<typeof listHostedBooks>>;
type OwnerBookRead = Awaited<ReturnType<typeof readOwnedHostedBook>>;

function StudioRoute() {
  const search = Route.useSearch();
  const loaded = Route.useLoaderData() as InventoryRead | OwnerBookRead | null;
  const session = useSession();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<HistoricalReaderSource | null>(null);
  useEffect(() => {
    setSource(session.state === 'signed-in' ? historicalReaderSource(queryClient) : null);
  }, [queryClient, session.state, session.subject]);
  const locale = getLocale();

  if (search.catalogueId) {
    if (!loaded || !('ok' in loaded) || !loaded.ok)
      return <StudioMessage message={loaded && 'ok' in loaded ? loaded.error.message : 'This book is unavailable.'} />;
    return (
      <BookStudioVisit
        book={loaded.value as HostedOwnerBook}
        source={source}
        accountId={session.subject ?? null}
        csrfToken={session.csrfToken}
        locale={locale}
      />
    );
  }
  if (search.books) {
    if (!loaded || !('ok' in loaded) || !loaded.ok)
      return (
        <StudioMessage message={loaded && 'ok' in loaded ? loaded.error.message : 'Hosted books are unavailable.'} />
      );
    return (
      <StudioLibrary inventory={loaded.value as HostedOwnerInventory} cursor={search.cursor ?? null} locale={locale} />
    );
  }
  return (
    <StudioAccountVisit
      source={source}
      accountId={session.subject ?? null}
      csrfToken={session.csrfToken}
      locale={locale}
      cursor={search.cursor ?? null}
      draftCursor={search.draftCursor ?? null}
      resumePostId={search.postId ?? null}
    />
  );
}

function StudioMessage({ message }: { message: string }) {
  return (
    <main className="mx-auto w-full max-w-4xl space-y-4 px-4 py-8">
      <h1>Studio</h1>
      <p role="alert">{message}</p>
    </main>
  );
}

function StudioLibrary({
  inventory,
  cursor,
  locale,
}: {
  inventory: HostedOwnerInventory;
  cursor: string | null;
  locale: Locale;
}) {
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <p className="studio-eyebrow">Author workspace</p>
        <h1 className="text-3xl font-semibold">Studio</h1>
        <p>Hosted books keep their independent organizer and frozen publication workflow.</p>
        <a className="studio-skip" href={localizeHref('/studio', { locale })}>
          {m.studio_account_return({}, { locale })}
        </a>
      </header>
      <section className="studio-stack" aria-labelledby="studio-books-heading">
        <h2 id="studio-books-heading">Your hosted books</h2>
        {inventory.items.length ? (
          <ol className="studio-draft-list">
            {inventory.items.map((book) => (
              <li key={book.catalogueId}>
                <a
                  className="studio-toc-open"
                  href={localizeHref(
                    `/studio?catalogueId=${encodeURIComponent(book.catalogueId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
                    { locale },
                  )}
                >
                  Book · {book.catalogueId}
                </a>
                <span className="studio-help">
                  {book.postVisibility === 'draft'
                    ? 'Private draft'
                    : book.postVisibility === 'protected'
                      ? 'Protected'
                      : 'Published'}
                  {' · '}Created{' '}
                  <time dateTime={book.createdAt}>{new Date(book.createdAt).toLocaleDateString(locale)}</time>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>No hosted books are available for this account.</p>
        )}
        {inventory.nextCursor ? (
          <a
            className="studio-skip"
            href={localizeHref(`/studio?books=1&cursor=${encodeURIComponent(inventory.nextCursor)}`, { locale })}
          >
            More books
          </a>
        ) : null}
      </section>
    </main>
  );
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
        if (!page.drafts.some((entry) => entry.id === resumePostId)) {
          resumeIssue = m.own_drafts_stale_selection({}, { locale });
        } else {
          const opened = await port.open({ projectId: accountId, postId: resumePostId }, controller.signal);
          if (opened.ok) initialSelection = opened.value;
          else resumeIssue = opened.error.message;
        }
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
        workspace: { input, port },
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
    source,
    visit.active,
    visit.commands,
    visit.current,
    visit.identity,
    visit.reader,
  ]);

  return (
    <main className="mx-auto w-full max-w-screen-2xl px-4 py-6">
      <nav
        className="mb-3 flex flex-wrap items-center justify-end"
        aria-label={m.studio_account_sections({}, { locale })}
      >
        <a className="studio-skip" href={localizeHref('/studio?books=1', { locale })}>
          {m.studio_account_open_books({}, { locale })}
        </a>
      </nav>
      {!visit.active || !source || !accountId ? waitForSession() : null}
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
    </main>
  );
}

function waitForSession() {
  return <p role="status">{m.studio_account_preparing({}, { locale: getLocale() })}</p>;
}

function StudioResultMessage({ result }: { result: StudioResult<unknown> | null }) {
  return result ? (
    <StudioMessage message={result.ok ? 'The Studio visit could not be opened.' : result.error.message} />
  ) : (
    waitForSession()
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

function BookStudioVisit({
  book,
  source,
  accountId,
  csrfToken,
  locale,
}: {
  book: HostedOwnerBook;
  source: HistoricalReaderSource | null;
  accountId: string | null | undefined;
  csrfToken: string | null;
  locale: Locale;
}) {
  const [workspace, setWorkspace] = useState<Parameters<typeof StudioWorkspace>[0] | null>(null);
  const [result, setResult] = useState<StudioResult<unknown> | null>(null);
  useEffect(() => {
    if (!source || !accountId) return;
    const controller = new AbortController();
    const origin = source.read();
    const admittedPosts = new Map<string, string>([[book.catalogueId, book.threadId]]);
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
      admitsPost: (postId) => admittedPosts.has(postId),
    });
    const resolveTarget = async (document: ExactDocument, signal: AbortSignal): Promise<StudioResult<HostedTarget>> => {
      if (signal.aborted || !isCurrent()) return hostedFailure('denied', 'This Studio visit has ended.');
      const threadId = admittedPosts.get(document.postId);
      if (!threadId)
        return hostedFailure('unavailable', 'Only documents already admitted to this book can be placed here.');
      return { ok: true, value: { threadId, ...document } };
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
            title: 'Book post',
            revisionId: book.postRevisionId,
            updatedAt: book.createdAt,
            state: book.postVisibility,
          };
      const input: HostedStudioInput = {
        visitKey: JSON.stringify([accountId, origin.generation, book.catalogueId]),
        projectId: book.catalogueId,
        title: initialSelection?.revision.title ?? 'Book Studio',
        documents: { items: [document], nextCursor: null },
        publications: { items: [], nextCursor: null },
        ...(initialSelection ? { initialSelection } : {}),
        canCreateDraft: false,
      };
      const bound = await openHostedStudio(
        { catalogueId: book.catalogueId, accountId, input, documents, resolveTarget, isCurrent },
        controller.signal,
      );
      if (!isCurrent()) return;
      setResult(bound);
      if (!bound.ok) return;
      for (const target of bound.value.book.chapterTargets()) admittedPosts.set(target.postId, target.threadId);
      setWorkspace(bound.value.workspace);
    };
    void run();
    return () => controller.abort();
  }, [book, source, accountId, csrfToken, locale]);
  if (workspace)
    return (
      <main className="mx-auto w-full max-w-screen-2xl px-4 py-6">
        <StudioWorkspace {...workspace} />
      </main>
    );
  return <StudioResultMessage result={result} />;
}
