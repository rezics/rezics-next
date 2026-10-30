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
  loader: ({ deps }) =>
    readPersonalLibrary({
      data: {
        ...(deps.state ? { state: deps.state } : {}),
        ...(deps.cursor ? { cursor: deps.cursor } : {}),
      },
    }),
  head: ({ match }) =>
    pageHead({ title: m.library_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: LibraryRoute,
});

function LibraryRoute() {
  const search = validateShelfSearch(Route.useSearch());
  return (
    <PersonalLibraryPage
      page={Route.useLoaderData()}
      locale={getLocale()}
      display={shelfDisplay(search)}
      cursor={search.cursor}
    />
  );
}
