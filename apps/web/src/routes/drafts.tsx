import { createFileRoute } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { DraftsRoute } from '../threads/drafts-route';
import { pageHead } from '../shell/head';
import { pageHeadContext } from '../shell/head-context';
import { requireSignedIn } from '../session/guard';

export const Route = createFileRoute('/drafts')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.own_drafts_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: DraftsRoute,
});
