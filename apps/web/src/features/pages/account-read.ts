import type { CoverSummary } from '@rezics/ui/cover';
import { isRecord } from './shared';

/** The public profile `GET /v1/accounts?handle=` returns for one active account. */
export type AccountProfile = {
  id: string;
  kind: string;
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  links: { label: string; url: string }[];
  avatar: CoverSummary | null;
  verified: boolean;
  automated: boolean;
  operatorId: string | null;
  publicViews: { posts: boolean; reviews: boolean; collections: boolean };
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
    displayName: typeof account.displayName === 'string' && account.displayName ? account.displayName : null,
    bio: typeof account.bio === 'string' && account.bio ? account.bio : null,
    links: (Array.isArray(account.links) ? account.links : []).flatMap((link) =>
      isRecord(link) && typeof link.label === 'string' && typeof link.url === 'string'
        ? [{ label: link.label, url: link.url }]
        : [],
    ),
    avatar: isRecord(account.avatar) ? (account.avatar as unknown as CoverSummary) : null,
    verified: account.verified === true,
    automated: account.automated === true,
    operatorId: typeof account.operatorId === 'string' ? account.operatorId : null,
    publicViews: {
      posts: views.posts !== false,
      reviews: views.reviews !== false,
      collections: views.collections !== false,
    },
  };
}

/** Whether the account lets everyone see this activity view; every other view is not the account's to hide. */
export function viewIsPublic(profile: AccountProfile | undefined, view: string): boolean {
  if (!profile) return true;
  return view === 'posts' || view === 'reviews' || view === 'collections' ? profile.publicViews[view] : true;
}
