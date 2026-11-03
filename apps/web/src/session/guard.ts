import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { normalizeSessionObservation } from './browser-state';
import { sessionQuery } from './query';

type GuardContext = {
  context: { queryClient: QueryClient };
  location: { publicHref: string };
};

const signedInPaths = [
  /^\/collections\/[^/]+\/publish(?:\/|$)/,
  /^\/operations(?:\/|$)/,
  /^\/my\/contexts(?:\/|$)/,
  /^\/editions\/?$/,
  /^\/editions\/new(?:\/|$)/,
  /^\/imports\/review(?:\/|$)/,
  /^\/my\/zones(?:\/|$)/,
  /^\/access(?:\/|$)/,
  /^\/platform\/accounts(?:\/|$)/,
  /^\/platform\/exposure(?:\/|$)/,
  /^\/creator\/statements(?:\/|$)/,
  /^\/creator\/sales(?:\/|$)/,
  /^\/creator\/offers(?:\/|$)/,
  /^\/entitlements(?:\/|$)/,
  /^\/(?:accounts(?:\/|$)|review\/account-verifications(?:\/|$))/,
  /^\/organizations(?:\/|$)/,
  /^\/collections\/[^/]+\/rule\/?$/,
  /^\/(?:library(?:\/|$)|settings(?:\/|$)|collections\/new(?:\/|$)|boards\/[^/]+\/new(?:\/|$)|orders(?:\/|$)|curate\/presentation(?:\/|$)|realms(?:\/|$)|moderation\/(?:workbench(?:\/|$)|(?:decisions|reports)\/[^/]+(?:\/|$)))/,
];

/** Whether a localized route pathname belongs to a page protected by `requireSignedIn`. */
export function isSignedInPath(pathname: string): boolean {
  const path = pathname.replace(/^\/(?:en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|$)/, '') || '/';
  return signedInPaths.some((pattern) => pattern.test(path));
}

/** Run before a personal page's loader, sharing the shell's session cache. */
export async function requireSignedIn({ context, location }: GuardContext): Promise<void> {
  try {
    await context.queryClient.ensureQueryData(sessionQuery);
  } catch {
    throw new Error('Session unavailable');
  }

  // ensureQueryData intentionally returns retained data after a failed fetch. Only the
  // successful current cache observation may authorize a personal route loader.
  const queryState = context.queryClient.getQueryState(sessionQuery.queryKey);
  if (!queryState || queryState.status !== 'success') throw new Error('Session unavailable');
  const session = normalizeSessionObservation(queryState.data);
  if (session.state === 'signed-out') {
    const url = new URL(location.publicHref, 'https://site.invalid');
    throw redirect({
      href: `/auth/sign-in?return_to=${encodeURIComponent(url.pathname + url.search)}`,
      statusCode: 302,
      reloadDocument: true,
    });
  }
  if (session.state !== 'signed-in') throw new Error('Session unavailable');
}
