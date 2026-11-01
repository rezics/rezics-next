import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { myRealmsQuery } from '../../community/realm-membership-queries';
import { captureMyRealmsCaller, MyRealmsCallerHost } from '../../community/my-realms-caller';
import { ClosedErrorPage } from '../../shell/closed';
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
  errorComponent: ClosedErrorPage,
  component: MyRealms,
});

function MyRealms() {
  const initial = Route.useLoaderData();
  const { cursor } = Route.useSearch();
  return <MyRealmsCallerHost key={initial.visit.id} initial={initial} cursor={cursor} />;
}
