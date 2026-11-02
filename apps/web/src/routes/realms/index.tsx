import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute, Link } from '@tanstack/react-router';
import { myRealmsQuery } from '../../community/realm-membership-queries';
import { captureMyRealmsCaller, MyRealmsCallerHost } from '../../community/my-realms-caller';
import { ClosedErrorPage } from '../../shell/closed';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/realms/')({
  beforeLoad: requireSignedIn,
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' && search.cursor ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: async ({ context, deps, abortController }) => {
    const caller = await captureMyRealmsCaller(context.queryClient, {
      cursor: deps.cursor,
      locale: getLocale(),
      credentialMode: 'session',
    });
    const stopOnAbort = () => caller.retire();
    abortController.signal.addEventListener('abort', stopOnAbort, { once: true });
    try {
      abortController.signal.throwIfAborted();
      const page = await context.queryClient.fetchQuery(myRealmsQuery(deps.cursor, caller));
      abortController.signal.throwIfAborted();
      return { page, visit: caller.acceptLoaderResult(page) };
    } catch (error) {
      caller.retire();
      throw error;
    } finally {
      abortController.signal.removeEventListener('abort', stopOnAbort);
    }
  },
  head: ({ match }) =>
    pageHead({ title: m.realms_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  errorComponent: MyRealmsErrorPage,
  component: MyRealms,
});

function failureStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as { status?: unknown; statusCode?: unknown; problem?: { status?: unknown } };
  for (const status of [value.status, value.statusCode, value.problem?.status])
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  return undefined;
}

function canRestartContinuation(error: unknown) {
  if (isPlatformClosedError(error)) return false;
  const status = failureStatus(error);
  return status === undefined || status === 408 || status >= 500;
}

function MyRealmsErrorPage({ error, reset }: { error: unknown; reset?: () => void }) {
  const { cursor } = Route.useSearch();
  return (
    <>
      <ClosedErrorPage error={error} reset={reset} />
      {cursor && canRestartContinuation(error) ? (
        <nav aria-label={m.realms_heading()} className="max-w-prose">
          <Link
            to="/realms"
            search={{}}
            className="inline-flex min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal rounded-lg border border-border px-4 py-2 text-start text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.realms_first_page()}
          </Link>
        </nav>
      ) : null}
    </>
  );
}

function MyRealms() {
  const initial = Route.useLoaderData();
  const { cursor } = Route.useSearch();
  return <MyRealmsCallerHost key={initial.visit.id} initial={initial} cursor={cursor} />;
}
