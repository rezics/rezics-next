import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import { StudioWorkspace, type StudioDocument, type StudioInput, type StudioPort, type StudioResult } from '../studio';
import type { ExactDocument, StudioSelection } from '../studio/contract';
import { createPostDocumentPort } from '../studio/post-document-port';
import { openHostedStudio, type HostedStudioInput } from '../studio/hosted-workspace';
import type { HostedOwnerBook, HostedOwnerInventory, HostedTarget } from '../studio/hosted-contract';
import { hostedId } from '../studio/hosted-contract';
import { hostedFailure } from '../studio/hosted-native';
import { listHostedBooks, readOwnedHostedBook } from '../studio/hosted-actions';
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
    cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
  }),
  v.check((value) => !(value.catalogueId && value.postId)),
);

export const Route = createFileRoute('/studio')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: unknown) => v.parse(searchSchema, search),
  loaderDeps: ({ search }) => ({
    catalogueId: search.catalogueId ?? null,
    postId: search.postId ?? null,
    cursor: search.cursor ?? null,
  }),
  loader: ({ deps }) =>
    deps.catalogueId
      ? readOwnedHostedBook({ data: { catalogueId: deps.catalogueId } })
      : deps.postId
        ? Promise.resolve(null)
        : listHostedBooks({ data: { cursor: deps.cursor } }),
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

  if (search.postId)
    return (
      <ColumnStudioVisit
        postId={search.postId}
        source={source}
        accountId={session.subject ?? null}
        csrfToken={session.csrfToken}
        locale={locale}
      />
    );
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
  if (!loaded || !('ok' in loaded) || !loaded.ok)
    return (
      <StudioMessage
        message={loaded && 'ok' in loaded ? loaded.error.message : 'Your Studio library is unavailable.'}
      />
    );
  return (
    <StudioLibrary inventory={loaded.value as HostedOwnerInventory} cursor={search.cursor ?? null} locale={locale} />
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
        <p>
          Open a hosted book or continue an existing column draft. Draft creation starts in its owning Content flow.
        </p>
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
            href={localizeHref(`/studio?cursor=${encodeURIComponent(inventory.nextCursor)}`, { locale })}
          >
            More books
          </a>
        ) : null}
      </section>
      <section className="studio-stack" aria-labelledby="studio-column-heading">
        <h2 id="studio-column-heading">Continue a column draft</h2>
        <p>Open an opening post from your drafts page to edit its text, preview it, and compare saved revisions.</p>
        <a className="studio-skip" href={localizeHref('/drafts', { locale })}>
          Open my drafts
        </a>
      </section>
    </main>
  );
}

function waitForSession() {
  return <p role="status">Preparing your private Studio visit…</p>;
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

function ColumnStudioVisit({
  postId,
  source,
  accountId,
  csrfToken,
  locale,
}: {
  postId: string;
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
      projectId: postId,
      accountId,
      locale,
      source,
      csrfToken,
      isCurrent,
      admitsPost: (candidate) => candidate === postId,
    });
    void documents
      .open({ projectId: postId, postId }, controller.signal)
      .then((opened) => {
        if (!isCurrent()) return;
        if (!opened.ok) {
          setResult(opened);
          return;
        }
        if (!opened.value.permissions.edit || opened.value.visibility !== 'draft') {
          setResult(hostedFailure('denied', 'Studio can open only your existing private column drafts.'));
          return;
        }
        const unavailable = async () =>
          hostedFailure('unavailable', 'Article publication is not available in this workspace.');
        const port: StudioPort = {
          ...documents,
          reviewPublication: unavailable,
          publish: unavailable,
          publications: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        };
        const input: StudioInput = {
          visitKey: JSON.stringify([accountId, origin.generation, postId]),
          projectId: postId,
          title: 'Column Studio',
          profile: { kind: 'articles', seriesTitle: null },
          documents: { items: [documentRow(opened.value)], nextCursor: null },
          publications: { items: [], nextCursor: null },
          initialSelection: opened.value,
          canCreateDraft: false,
          canPublish: false,
          publicationUnavailableReason:
            'The current Content API has no reviewed article publication operation. Existing draft editing, preview, and exact revision history use the shared Post API.',
        };
        if (isCurrent()) setWorkspace({ input, port });
      })
      .catch(() => {
        if (isCurrent()) setResult(hostedFailure('unavailable', 'This column draft could not be opened.'));
      });
    return () => controller.abort();
  }, [postId, source, accountId, csrfToken, locale]);
  if (workspace)
    return (
      <main className="mx-auto w-full max-w-screen-2xl px-4 py-6">
        <StudioWorkspace {...workspace} />
      </main>
    );
  return <StudioResultMessage result={result} />;
}
