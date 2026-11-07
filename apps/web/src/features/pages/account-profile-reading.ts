import type { CoverSummary } from '@rezics/ui/cover';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { isRecord } from './shared';
import { pageContext, type SubjectPageData } from './page-model';
import type { CollectionWindowReading } from './account-profile-port';

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

/** The successful public projection of the resolved page account, regardless of descriptor order. */
export function pageProfile(page: SubjectPageData) {
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind !== 'account' || page.reads[key]?.status !== 200) continue;
    const profile = accountOf(page.reads[key]?.body);
    if (profile?.id === page.account?.id) return profile;
  }
}

/** Keep the exact native publication object used by the contribution receipt lifetime. */
export function accountPublicationSource(page: SubjectPageData, accountId: string): object | null {
  for (const result of Object.values(page.reads)) {
    if (result.status !== 200 || !isRecord(result.body)) continue;
    const accounts = result.body.accounts;
    if (!Array.isArray(accounts)) continue;
    const source = accounts.find((account) => isRecord(account) && account.id === accountId);
    if (source) return source;
  }
  return null;
}

/** Plan once at the page boundary; the collection host knows neither templates nor Agent readers. */
export function accountCollectionWindowReading(
  page: SubjectPageData | undefined,
): CollectionWindowReading | null | undefined {
  if (!page) return;
  const profile = pageProfile(page);
  if (!profile) return null;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  const entry = Object.entries(plan.reads).find(([, read]) => read.kind === 'accountCollections');
  const response = entry ? page.reads[entry[0]] : undefined;
  return {
    accountId: profile.id,
    publication: JSON.stringify(profile),
    published: profile.publicViews.collections,
    admitted: response?.status === 200 && isRecord(response.body) && Array.isArray(response.body.collections),
    denied: response?.status === 401 || response?.status === 403,
  };
}
