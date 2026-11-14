import { createFileRoute } from '@tanstack/react-router';
import { preparePrivatePage } from '../../kernel/client';
import { requireSignedIn } from '../../session/guard';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { insightsHref, insightsSearch } from '../../library/reading-insights/address';
import { ReadingInsightsPage } from '../../library/reading-insights/page';

export const Route = createFileRoute('/library/insights')({
  beforeLoad: async (context) => { preparePrivatePage(); await requireSignedIn(context); },
  validateSearch: insightsSearch,
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) => pageHead({ title: m.library_insights_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function InsightsRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const year = search.year === 'invalid' ? undefined : search.year ?? new Date().getUTCFullYear();
    const locale = getLocale();
    return <ReadingInsightsPage key={`${locale}:${year}`} year={year} onYear={(selected) => { void navigate({ href: insightsHref(selected, locale) }); }} />;
  },
});
