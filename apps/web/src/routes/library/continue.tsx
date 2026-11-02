import { useCallback } from 'react';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { prepareExposure } from '../../kernel/exposure';
import { requireSignedIn } from '../../session/guard';
import { ContinueSection, useContinueRefresh } from '../../library/continue';
import { readContinueEntries } from '../../library/continue-read';
import { continueNewestHref } from '../../library/continue-address';
import { LibraryNavigation } from '../../library/library-nav';
import { useCurrentLibraryNavigation } from '../../library/pins-current';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { PageHeading } from '../../shell/page-heading';

export const Route = createFileRoute('/library/continue')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  validateSearch: (search: Record<string, unknown>) => ({
    cursor: search.cursor,
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ deps }) => readContinueEntries({ data: deps }),
  head: ({ match }) =>
    pageHead({ title: m.library_continue(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ContinuePage,
});

function ContinuePage() {
  const locale = getLocale();
  const { cursor } = Route.useSearch();
  const initial = Route.useLoaderData();
  const location = useLocation();
  const read = useCallback(() => readContinueEntries({ data: { cursor } }), [cursor]);
  const scope = `${locale}:${location.searchStr}`;
  const resume = useContinueRefresh(initial, read, scope);
  const navigation = useCurrentLibraryNavigation(locale, 8, scope);
  return (
    <div className="container mx-auto max-w-7xl space-y-8 px-4 py-8">
      <PageHeading>{m.library_continue()}</PageHeading>
      <LibraryNavigation
        current="continue"
        locale={locale}
        pins={navigation.data?.pins ?? { state: 'closed' }}
        collections={navigation.data?.collections ?? []}
      />
      <ContinueSection
        destination
        newestHref={continueNewestHref(locale, location.searchStr, location.hash)}
        state={resume.result}
        locale={locale}
        onRetry={() => void resume.refresh()}
        busy={resume.busy}
      />
    </div>
  );
}
