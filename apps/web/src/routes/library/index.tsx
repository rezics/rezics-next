import { prepareExposure } from '../../kernel/exposure';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { PersonalLibraryPage } from '../../library/entries-page';
import { readPersonalLibrary } from '../../library/entries-actions';
import { shelfDisplay, validateShelfSearch } from '../../library/shelf-params';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { readContinueEntries } from '../../library/continue-read';

export const Route = createFileRoute('/library/')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  validateSearch: validateShelfSearch,
  // The router merges what the address says over what validation returns, so a value the validator dropped is still
  // there; reading through the validator again keeps only the documented values.
  loaderDeps: ({ search }) => {
    const { state, cursor } = validateShelfSearch(search);
    return { state, cursor };
  },
  loader: async ({ deps }) => {
    const [page, continueEntries] = await Promise.all([
      readPersonalLibrary({
        data: { ...(deps.state ? { state: deps.state } : {}), ...(deps.cursor ? { cursor: deps.cursor } : {}) },
      }),
      readContinueEntries(),
    ]);
    return { page, continueEntries };
  },
  head: ({ match }) =>
    pageHead({ title: m.library_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: LibraryRoute,
});

function LibraryRoute() {
  const search = validateShelfSearch(Route.useSearch());
  return (
    <PersonalLibraryPage
      page={Route.useLoaderData().page}
      continueEntries={Route.useLoaderData().continueEntries}
      locale={getLocale()}
      display={shelfDisplay(search)}
      {...(search.cursor ? { cursor: search.cursor } : {})}
    />
  );
}
