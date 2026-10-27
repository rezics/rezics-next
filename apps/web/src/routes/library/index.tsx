import { createFileRoute } from '@tanstack/react-router';
import { PersonalLibraryPage } from '../../library/entries-page';
import { readPersonalLibrary } from '../../library/entries-actions';
import { shelfDisplay, validateShelfSearch } from '../../library/shelf-params';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';

export const Route = createFileRoute('/library/')({
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
  head: () => ({ meta: [{ title: m.library_heading() }] }),
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
