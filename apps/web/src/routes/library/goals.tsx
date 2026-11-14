import { createFileRoute } from '@tanstack/react-router';
import { preparePrivatePage } from '../../kernel/client';
import { yearlyGoalSearch } from '../../library/yearly-goal-address';
import { CurrentYearlyGoal } from '../../library/yearly-goal-current';
import { m } from '../../paraglide/messages.js';
import { requirePrivatePageAccess } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/goals')({
  beforeLoad: async (context) => {
    preparePrivatePage();
    await requirePrivatePageAccess(context);
  },
  validateSearch: yearlyGoalSearch,
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.library_yearly_goal_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function YearlyGoalRoute() {
    const search = Route.useSearch();
    const year = search.year === 'invalid' ? undefined : (search.year ?? new Date().getUTCFullYear());
    return <CurrentYearlyGoal year={year} />;
  },
});
