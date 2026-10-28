import { createFileRoute, redirect } from '@tanstack/react-router';
import * as v from 'valibot';
import { getLocale } from '../../paraglide/runtime.js';
import { threadSlugQuery } from '../../threads/thread-queries';
import { rememberThreadSlug, threadLocation } from '../../threads/thread-href';

function threadSearch(search: Record<string, unknown>): { cursor?: string } {
  const cursor = v.parse(v.fallback(v.optional(v.string()), undefined), search.cursor);
  return typeof cursor === 'string' ? { cursor } : {};
}

/** The id without a slug redirects to the canonical thread URL and keeps the cursor. */
export const Route = createFileRoute('/threads/$id')({
  validateSearch: threadSearch,
  loaderDeps: ({ search }) => ({ cursor: threadSearch(search).cursor }),
  loader: async ({ params, deps, context }) => {
    const head = await context.queryClient.ensureQueryData(threadSlugQuery(params.id, context.credentialMode));
    rememberThreadSlug(head.id, head.title);
    throw redirect({ href: threadLocation(getLocale(), head, deps.cursor), statusCode: 301 });
  },
  component: () => null,
});
