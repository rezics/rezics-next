import type { CoverSummary } from '@rezics/ui/cover';
import type { KernelClient } from '@rezics/client';
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
      followCountsTarget: { targetType: 'subject'; targetId: string } | null;
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
    followCountsTarget: null,
  };
}

/** Bind a full profile and private destinations to the immutable displayed Account, never its old spelling. */
export async function loadAccountPageContext(
  client: KernelClient,
  id: string,
  authorization: string | null,
  securityHref: string | null,
): Promise<AccountPageContext> {
  const options = { fetch: { cache: 'no-store' as const, redirect: 'manual' as const } };
  const profileRead = async () => {
    const identities = await client.accounts.get({ ...options, query: { ids: id } });
    if (identities.error || identities.status !== 200) return null;
    const identity = accountOf(identities.data);
    if (identity?.id !== id || !identity.handle) return null;
    const profile = await client.accounts.get({ ...options, query: { handle: identity.handle } });
    return profile.status === 200 && !profile.error ? profile.data : null;
  };
  const [publicBody, advice] = await Promise.all([
    profileRead(),
    authorization
      ? client.viewerActions.post(
          { resources: [{ type: 'access.account', id }] },
          { ...options, headers: { authorization } },
        )
      : null,
  ]);
  let viewer: AccountViewerActions | undefined;
  if (advice) {
    if (advice.error || advice.status !== 200) return { state: 'unavailable' };
    const resource = advice.data?.resources.find((item) => item.type === 'access.account' && item.id === id);
    if (!resource || !('viewerActions' in resource)) return { state: 'unavailable' };
    viewer = { state: 'ready', actions: resource.viewerActions, securityHref };
  }
  const context = accountPageContextFromReads(id, publicBody, viewer);
  if (context.state !== 'ready' || !authorization || !context.profile.subject) return context;
  const target = { targetType: 'subject' as const, targetId: context.profile.subject.id };
  // Count authority deliberately differs from profile-edit authority for operated actors.
  // The native count read checks the actual Account, its self exception, scopes and gates.
  const count = await client
    .followCounts({ targetType: target.targetType })({ targetId: target.targetId })
    .get({
      ...options,
      headers: { authorization },
    });
  if (
    !count.error &&
    count.status === 200 &&
    count.data?.targetType === target.targetType &&
    count.data.targetId === target.targetId &&
    Number.isSafeInteger(count.data.followerCount) &&
    count.data.followerCount >= 0
  )
    return { ...context, followCountsTarget: target };
  return context;
}

export function accountFollowCountsHref(context: AccountPageContext | undefined, locale: string): string | null {
  if (context?.state !== 'ready' || !context.followCountsTarget) return null;
  const query = new URLSearchParams(context.followCountsTarget);
  return `/${encodeURIComponent(locale)}/library/follow-counts?${query}`;
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
      const stale = await prepareSession(request, sessionEnv);
      return await loadAccountPageContext(
        kernelClient(),
        data,
        stale ? null : (viewerCredential(request) ?? null),
        securityHrefFromIssuer(sessionEnv.AUTH_ISSUER),
      );
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
      posts: views.posts === true,
      reviews: views.reviews === true,
      collections: views.collections === true,
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
