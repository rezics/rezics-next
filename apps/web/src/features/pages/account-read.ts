import type { CoverSummary } from '@rezics/ui/cover';
import { isRecord } from './shared';
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

/** The public profile `GET /v1/accounts?handle=` returns for one active account. */
export type AccountProfile = {
  id: string;
  kind: string;
  handle: string | null;
  movedTo?: string;
  displayName: string | null;
  bio: string | null;
  links: { label: string; url: string }[];
  avatar: CoverSummary | null;
  subject: { id: string; label: string; type: string } | null;
  verified: boolean;
  automated: boolean;
  operated?: boolean;
  operatorId: string | null;
  publicViews: { posts: boolean; reviews: boolean; collections: boolean; realms: boolean };
};

/** The profile in an account read's body, when the read returned an active account with its presentation. */
export function accountOf(body: unknown): AccountProfile | undefined {
  const accounts = isRecord(body) ? body.accounts : undefined;
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (!isRecord(account) || typeof account.id !== 'string' || account.state !== 'active') return;
  const views = isRecord(account.publicViews) ? account.publicViews : {};
  return {
    id: account.id,
    kind: typeof account.kind === 'string' ? account.kind : 'actor',
    handle: typeof account.handle === 'string' ? account.handle : null,
    ...(typeof account.movedTo === 'string' ? { movedTo: account.movedTo } : {}),
    displayName: typeof account.displayName === 'string' && account.displayName ? account.displayName : null,
    bio: typeof account.bio === 'string' && account.bio ? account.bio : null,
    links: (Array.isArray(account.links) ? account.links : []).flatMap((link) =>
      isRecord(link) && typeof link.label === 'string' && typeof link.url === 'string'
        ? [{ label: link.label, url: link.url }]
        : [],
    ),
    avatar: isRecord(account.avatar) ? (account.avatar as unknown as CoverSummary) : null,
    subject:
      isRecord(account.subject) &&
      typeof account.subject.id === 'string' &&
      account.subject.id &&
      typeof account.subject.label === 'string' &&
      account.subject.label &&
      typeof account.subject.type === 'string'
        ? { id: account.subject.id, label: account.subject.label, type: account.subject.type }
        : null,
    verified:
      account.verified === true &&
      isRecord(account.subject) &&
      typeof account.subject.id === 'string' &&
      !!account.subject.id &&
      typeof account.subject.label === 'string' &&
      !!account.subject.label &&
      typeof account.subject.type === 'string',
    automated: account.automated === true,
    ...(account.operated === true || typeof account.operatorId === 'string' ? { operated: true } : {}),
    operatorId: typeof account.operatorId === 'string' ? account.operatorId : null,
    publicViews: {
      posts: views.posts !== false,
      reviews: views.reviews !== false,
      collections: views.collections !== false,
      realms: views.realms === true,
    },
  };
}

/** Whether the account lets everyone see this activity view; every other view is not the account's to hide. */
export function viewIsPublic(profile: AccountProfile | undefined, view: string): boolean {
  // Content's author discussion page uses publicViews.posts, independently of reviews.
  if (view === 'discussion') return profile?.publicViews.posts === true;
  if (!profile) return !['posts', 'reviews', 'collections', 'realms'].includes(view);
  return view === 'posts' || view === 'reviews' || view === 'collections' || view === 'realms'
    ? profile.publicViews[view]
    : true;
}
