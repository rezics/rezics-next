import { createFileRoute } from '@tanstack/react-router';
import { AccountManagementJourney } from '../../account-verification/journeys';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/accounts/')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.av_accounts(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: AccountManagementJourney,
});
