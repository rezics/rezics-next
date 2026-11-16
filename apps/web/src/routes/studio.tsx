import { lazy, Suspense } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { readOwnedHostedBook } from '../studio/hosted-actions';
import { hostedId } from '../studio/hosted-contract';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { requireSignedIn } from '../session/guard';
import { pageHead } from '../shell/head';
import { pageHeadContext } from '../shell/head-context';
import { StudioMessage, StudioPreparing } from './-studio-state';

const StudioVisit = lazy(() => import('./-studio-visit'));

const searchSchema = v.pipe(
  v.strictObject({
    catalogueId: v.optional(hostedId),
    postId: v.optional(hostedId),
    books: v.optional(v.literal('1')),
    append: v.optional(v.literal('1')),
    points: v.optional(v.literal('1')),
    prepare: v.optional(v.literal('1')),
    stageId: v.optional(hostedId),
    ownerAccount: v.optional(hostedId),
    ownerEpoch: v.optional(
      v.pipe(
        v.string(),
        v.regex(/^(0|[1-9][0-9]*)$/),
        v.check((value) => Number.isSafeInteger(Number(value))),
      ),
    ),
    cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
    draftCursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(32768))),
  }),
  v.check((value) => !(value.catalogueId && value.postId) && !(value.books && (value.catalogueId || value.postId))),
  v.check((value) => !(value.append || value.points || value.prepare) || value.catalogueId !== undefined),
  v.check((value) => !value.prepare || !(value.append || value.points)),
  v.check((value) => !value.stageId || value.prepare === '1'),
  v.check(
    (value) =>
      (value.ownerAccount === undefined && value.ownerEpoch === undefined) ||
      (value.catalogueId !== undefined && value.ownerAccount !== undefined && value.ownerEpoch !== undefined),
  ),
);

export type StudioSearch = v.InferOutput<typeof searchSchema>;

export const Route = createFileRoute('/studio')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: unknown) => v.parse(searchSchema, search),
  loaderDeps: ({ search }) => ({
    catalogueId: search.catalogueId ?? null,
    expectedViewer:
      search.ownerAccount !== undefined && search.ownerEpoch !== undefined
        ? { accountId: search.ownerAccount, authnEpoch: Number(search.ownerEpoch) }
        : undefined,
    postId: search.postId ?? null,
    books: search.books ?? null,
    cursor: search.cursor ?? null,
    draftCursor: search.draftCursor ?? null,
  }),
  loader: ({ deps }) =>
    deps.catalogueId
      ? readOwnedHostedBook({
          data: { catalogueId: deps.catalogueId, expectedViewer: deps.expectedViewer, locale: getLocale() },
        })
      : Promise.resolve(null),
  head: ({ match }) => {
    const context = pageHeadContext(match.pathname);
    return pageHead({ title: m.studio_title({}, { locale: context.locale }), robots: 'noindex, nofollow' }, context);
  },
  component: StudioRoute,
});

function StudioRoute() {
  const search = Route.useSearch();
  const book = Route.useLoaderData();
  const session = useSession();
  const locale = getLocale();

  if (search.catalogueId && (!book || !book.ok)) {
    return <StudioMessage message={book?.error.message ?? m.studio_workspace_book_unavailable({}, { locale })} />;
  }

  // The mounted shell and this route share the browser session read. Start it before
  // loading the private workspace so an editor import cannot delay session observation.
  const visit =
    session.state === 'signed-in' ? (
      <Suspense fallback={<StudioPreparing />}>
        <StudioVisit
          search={search}
          owner={book?.ok ? book.value : undefined}
          accountId={session.subject ?? null}
          csrfToken={session.csrfToken}
          locale={locale}
        />
      </Suspense>
    ) : (
      <StudioPreparing />
    );

  if (search.catalogueId || search.books) return visit;

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 py-6">
      <nav
        className="mb-3 flex flex-wrap items-center justify-end"
        aria-label={m.studio_account_sections({}, { locale })}
      >
        <a className="studio-skip" href={localizeHref('/studio?books=1', { locale })}>
          {m.studio_account_open_books({}, { locale })}
        </a>
      </nav>
      {visit}
    </div>
  );
}
