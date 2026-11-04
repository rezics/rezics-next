import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { normalizeSessionObservation } from './browser-state';
import { sessionQuery } from './query';
import { SessionUnavailableError } from './unavailable';

type GuardContext = {
  context: { queryClient: QueryClient };
  location: { publicHref: string };
};

export type SessionAccess = {
  state: 'signed-in' | 'unavailable';
  signInHref: string;
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

/** Read the current page session without turning an indeterminate result into anonymous access. */
export async function requirePrivatePageAccess({ context, location }: GuardContext): Promise<SessionAccess> {
  const url = new URL(location.publicHref, 'https://site.invalid');
  const signInHref = `/auth/sign-in?return_to=${encodeURIComponent(url.pathname + url.search)}`;
  try {
    await context.queryClient.ensureQueryData(sessionQuery);
  } catch {
    throw new SessionUnavailableError();
  }

  // ensureQueryData intentionally returns retained data after a failed fetch. Only the
  // successful current cache observation may authorize a personal route loader.
  const queryState = context.queryClient.getQueryState(sessionQuery.queryKey);
  if (!queryState || queryState.status !== 'success' || queryState.fetchStatus !== 'idle' || queryState.isInvalidated)
    throw new SessionUnavailableError();
  const session = normalizeSessionObservation(queryState.data);
  if (session.state === 'signed-out') {
    throw redirect({
      href: signInHref,
      statusCode: 302,
      reloadDocument: true,
    });
  }
  if (session.state !== 'signed-in') throw new SessionUnavailableError();
  return { state: 'signed-in', signInHref };
}

/** Existing guards keep throwing on an indeterminate session for routes without a prompt contract. */
export async function requireSignedIn(context: GuardContext): Promise<void> {
  const access = await requirePrivatePageAccess(context);
  if (access.state !== 'signed-in') throw new SessionUnavailableError();
}
