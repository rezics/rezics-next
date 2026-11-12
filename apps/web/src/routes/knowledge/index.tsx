import { createFileRoute } from '@tanstack/react-router';
import { KnowledgeNavigationRoute } from '../../knowledge/route';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/knowledge/')({
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  head: ({ match }) =>
    pageHead({ title: m.knowledge_navigation_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: KnowledgeNavigationRoute,
});
