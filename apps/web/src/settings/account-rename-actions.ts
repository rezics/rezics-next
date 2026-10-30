import { createServerFn } from '@tanstack/react-start';
import { authManagementPageHref } from '../session/auth-page-routes';
import type { SessionEnv } from '../session/client';
import type { AccountRenameContext } from './account-rename-data';

export type AccountRenameNavigation = AccountRenameContext & { href?: string | null };

/** Compose deployment availability after the existing native current-capability read. */
export function accountRenameNavigation(
  env: Readonly<Partial<SessionEnv>>,
  context: AccountRenameContext | null,
): AccountRenameNavigation | null {
  if (!context) return null;
  return {
    ...context,
    href: context.available ? authManagementPageHref(env, '/account/rename') : null,
  };
}

/** Browser-only region read; POST uses the ordinary Origin and session CSRF checks. */
export const readAccountRename = createServerFn({ method: 'POST' }).handler(
  async (): Promise<AccountRenameNavigation | null> => {
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const { kernelClient } = await import('../kernel/client');
    const { loadAccountRenameRegion } = await import('./account-rename-data');
    const sessionEnv = env as Partial<SessionEnv>;
    const context = await loadAccountRenameRegion(kernelClient(), getRequest(), sessionEnv);
    return accountRenameNavigation(sessionEnv, context);
  },
);
