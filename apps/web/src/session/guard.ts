import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { sessionQuery } from './query';

type GuardContext = {
  context: { queryClient: QueryClient };
  location: { publicHref: string };
};

/** Run before a personal page's loader, sharing the shell's session cache. */
export async function requireSignedIn({ context, location }: GuardContext): Promise<void> {
  const session = await context.queryClient.ensureQueryData(sessionQuery);
  if (session.state === 'unavailable') throw new Error('Session unavailable');
  if (session.state === 'signed-out') {
    const url = new URL(location.publicHref, 'https://site.invalid');
    throw redirect({
      href: `/auth/sign-in?return_to=${encodeURIComponent(url.pathname + url.search)}`,
      statusCode: 302,
      reloadDocument: true,
    });
  }
}
