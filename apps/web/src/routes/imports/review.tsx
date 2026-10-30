import { createFileRoute } from '@tanstack/react-router';
import { ProviderQueueJourney } from '../../features/import-review/provider-queue-journey';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/imports/review')({
  beforeLoad: requireSignedIn,
  head: ({ match }) => pageHead({ title: m.prq_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ProviderQueueJourney,
});
