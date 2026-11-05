import { createFileRoute } from '@tanstack/react-router';
import { ReviewJourney } from '../../account-verification/journeys';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/review/account-verifications')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.av_review_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ReviewJourney,
});
