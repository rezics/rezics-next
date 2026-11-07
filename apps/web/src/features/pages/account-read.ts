import { accountOf, type AccountProfile } from './account-profile-reading';
export { accountOf, viewIsPublic, type AccountProfile } from './account-profile-reading';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../../session/client';

export type AccountViewerActions =
  | { state: 'ready'; actions: { action: string; operations: string[] }[]; securityHref: string | null }
  | { state: 'unavailable' };

export type AccountPageContext =
  | {
      state: 'ready';
      profile: AccountProfile;
      viewerState: 'signed-in' | 'signed-out';
      actions: { action: string; operations: string[] }[];
      securityHref: string | null;
    }
  | { state: 'unavailable' };

/** Compose only the public allowlist and the native viewer-action answer for this displayed account. */
export function accountPageContextFromReads(
  id: string,
  publicBody: unknown,
  viewer: AccountViewerActions | undefined,
): AccountPageContext {
  const profile = accountOf(publicBody);
  if (!profile || profile.id !== id || viewer?.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: 'ready',
    profile: {
      ...profile,
      ...(profile.operated || profile.operatorId !== null ? { operated: true } : {}),
      operatorId: null,
    },
    viewerState: viewer ? 'signed-in' : 'signed-out',
    actions: viewer?.state === 'ready' ? viewer.actions : [],
    securityHref: viewer?.state === 'ready' ? viewer.securityHref : null,
  };
}

/** Personal BFF read: the browser supplies only the displayed Account key. */
export const readAccountViewerActions = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    )
      throw new Error('Invalid account');
    return value;
  })
  .handler(async ({ data }): Promise<AccountPageContext> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const sessionEnv = env as Partial<SessionEnv>;
    const { prepareSession, viewerCredential } = await import('../../session/request');
    const { kernelClient } = await import('../../kernel/client');
    const { securityHrefFromIssuer } = await import('../../settings/account-safety-links');
    try {
      const request = getRequest();
      await prepareSession(request, sessionEnv);
      const publicResult = await kernelClient().accounts.get({ query: { ids: data } });
      if (publicResult.error || publicResult.status !== 200 || !publicResult.data) return { state: 'unavailable' };
      const authorization = viewerCredential(request);
      if (!authorization) return accountPageContextFromReads(data, publicResult.data, undefined);
      const result = await kernelClient().viewerActions.post(
        { resources: [{ type: 'access.account', id: data }] },
        { headers: { authorization } },
      );
      if (result.error || result.status !== 200) return { state: 'unavailable' };
      const resource = result.data?.resources.find((item) => item.type === 'access.account' && item.id === data);
      if (!resource || !('viewerActions' in resource)) return { state: 'unavailable' };
      return accountPageContextFromReads(data, publicResult.data, {
        state: 'ready',
        actions: resource.viewerActions,
        securityHref: securityHrefFromIssuer(sessionEnv.AUTH_ISSUER),
      });
    } catch {
      return { state: 'unavailable' };
    }
  });

export function accountOperationAllowed(
  value: AccountViewerActions | AccountPageContext | undefined,
  action: string,
  operation: string,
): boolean {
  return (
    value?.state === 'ready' &&
    value.actions.some((entry) => entry.action === action && entry.operations.includes(operation))
  );
}
