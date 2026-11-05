import { createServerFn } from '@tanstack/react-start';
import { isNotFound, isRedirect } from '@tanstack/react-router';
import { authManagementPageHref } from '../session/auth-page-routes';
import type { SessionEnv } from '../session/client';
import type { AccountRenameContext, AccountRenameFailure, AccountRenameReadResult } from './account-rename-data';

export type AccountRenameNavigation = AccountRenameContext & { href?: string | null };
export type AccountRenameResult = AccountRenameReadResult<AccountRenameNavigation>;

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

/** Redirect and not-found remain Start/Router control flow, including after a failed private read. */
export function accountRenameControlFlow(error: unknown): void {
  if (isRedirect(error) || isNotFound(error)) throw error;
}

/** Module, request-helper and serialization faults stay in the same plain unavailable envelope. */
export function accountRenameSetupFailure(error: unknown): AccountRenameResult {
  accountRenameControlFlow(error);
  return { context: null, failures: [{ kind: 'unavailable', status: null } satisfies AccountRenameFailure] };
}

/** Server-function transport drops custom properties; only JSON-safe metadata crosses the boundary. */
export function serializeAccountRenameResult(result: AccountRenameResult): AccountRenameResult {
  return JSON.parse(JSON.stringify(result)) as AccountRenameResult;
}

/** Setup and native faults stay in this envelope; createServerFn only supplies the POST/CSRF boundary. */
export async function runAccountRenameHandler(): Promise<AccountRenameResult> {
  try {
    const { setResponseHeader } = await import('@tanstack/react-start/server');
    setResponseHeader('cache-control', 'private, no-store');
    const { readSettingsViewer } = await import('./actions.server');
    const { readAccountRenameContextResult, accountRenameException } = await import('./account-rename-data');
    try {
      const viewer = await readSettingsViewer();
      if (!viewer) return { context: null };
      const result = await readAccountRenameContextResult(
        viewer.client,
        viewer.authorization,
        viewer.accountId,
        viewer.request.signal,
      );
      return serializeAccountRenameResult({
        ...result,
        context: accountRenameNavigation(viewer.sessionEnv, result.context),
      });
    } catch (error) {
      accountRenameControlFlow(error);
      return serializeAccountRenameResult({ context: null, failures: [accountRenameException(error)] });
    }
  } catch (error) {
    return serializeAccountRenameResult(accountRenameSetupFailure(error));
  }
}

/** Browser-only region read; POST uses the ordinary Origin and session CSRF checks. */
export const readAccountRename = createServerFn({ method: 'POST' }).handler(runAccountRenameHandler);
