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
