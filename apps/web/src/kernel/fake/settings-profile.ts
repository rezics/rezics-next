import type { FakeRoute } from '../fake-modules.ts';

function storyVariant(): string {
  const context = (globalThis as typeof globalThis & { __rezicsStoryContext?: { url?: string } }).__rezicsStoryContext;
  return new URL(context?.url ?? '/settings', 'http://rezics.local').searchParams.get('profile') ?? '';
}

const profile = (id: string, kind: 'actor' | 'organization', variant = '') => ({
  id,
  kind,
  handle: kind === 'actor' ? 'reader' : 'reading-club',
  displayName: kind === 'actor' ? 'Avery Reader' : 'Reading Club',
  bio: variant.includes('extended')
    ? 'I collect thoughtful stories and share notes about what I read. '.repeat(12).trim()
    : 'I collect thoughtful stories and share notes about what I read.',
  avatar: variant.includes('extended')
    ? {
        id: 'story-avatar',
        url: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="%23d7c8ad"/><circle cx="40" cy="30" r="15" fill="%23977d60"/><path d="M12 80c2-20 14-30 28-30s26 10 28 30" fill="%23977d60"/></svg>',
      }
    : null,
  links: variant.includes('extended')
    ? ['Website', 'Reading notes', 'Community', 'Portfolio', 'Contact'].map((label, index) => ({
        label,
        url: `https://example.test/${index + 1}`,
      }))
    : [{ label: 'Website', url: 'https://example.test' }],
  publicViews: { posts: true, reviews: true, collections: true, realms: true },
  ...(kind === 'organization' ? { speakersListed: false } : {}),
  verified: false,
  subject: null,
});

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/accounts',
    story: ({ request }) => {
      const url = new URL(request.url);
      const id = url.searchParams.get('ids') ?? 'reader';
      const variant = storyVariant();
      const byHandle = url.searchParams.has('handle');
      const accountId = byHandle ? (variant.includes('organization') ? 'org-story-viewer' : 'story-viewer') : id;
      const kind = variant.includes('organization') ? 'organization' : id.startsWith('org') ? 'organization' : 'actor';
      return { status: 200, accounts: [profile(accountId, kind, variant)], next: null };
    },
    fixture: ({ request }) => {
      const url = new URL(request.url);
      const id = url.searchParams.get('ids') ?? 'reader';
      const variant = storyVariant();
      const byHandle = url.searchParams.has('handle');
      const accountId = byHandle ? (variant.includes('organization') ? 'org-story-viewer' : 'story-viewer') : id;
      const kind = variant.includes('organization') ? 'organization' : id.startsWith('org') ? 'organization' : 'actor';
      return { status: 200, accounts: [profile(accountId, kind, variant)], next: null };
    },
  },
  {
    method: 'PATCH',
    path: /^\/v1\/accounts\/([^/]+)$/,
    story: ({ request, match }) =>
      request.json().then((body) => ({
        status: 200,
        accountId: decodeURIComponent(match?.[1] ?? ''),
        ...(body && typeof body === 'object' ? (body as object) : {}),
      })),
    fixture: () => ({ status: 200, accountId: 'reader' }),
  },
];
