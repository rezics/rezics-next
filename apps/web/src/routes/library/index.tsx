import { createFileRoute } from '@tanstack/react-router';
import { PersonalLibraryPage } from '../../library/entries-page';
import { readPersonalLibrary } from '../../library/entries-actions';
import { libraryEntryState } from '../../library/entries-read';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';

export const Route = createFileRoute('/library/')({
  validateSearch: (search: Record<string, unknown>) => {
    const state = typeof search.state === 'string' ? libraryEntryState(search.state) : undefined;
    const cursor = typeof search.cursor === 'string' && search.cursor ? search.cursor : undefined;
    return { ...(state ? { state } : {}), ...(cursor ? { cursor } : {}) };
  },
  loaderDeps: ({ search }) => ({ state: search.state, cursor: search.cursor }),
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
  return <PersonalLibraryPage page={Route.useLoaderData()} locale={getLocale()} />;
}
