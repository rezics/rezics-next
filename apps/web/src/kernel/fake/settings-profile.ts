import type { FakeRoute } from '../fake-modules.ts';
import type { ProfileLink, ProfileValues } from '../../settings/profile-data';
import { rebaseProfile, type ProfileEditorIO } from '../../settings/profile-write';

export type ProfileScenario =
  | 'normal'
  | 'empty'
  | 'organization'
  | 'pending'
  | 'lost'
  | 'refused'
  | 'unavailable'
  | 'handleless'
  | 'readback';

export function profileStoryValues(kind: 'actor' | 'organization' = 'actor'): ProfileValues {
  return {
    accountId: kind === 'actor' ? 'story-viewer' : 'org-story-viewer',
    kind,
    displayName: kind === 'actor' ? 'Avery Reader' : 'Reading Club',
    biography: 'I collect thoughtful stories and share notes about what I read.',
    avatar: null,
    links: [{ label: 'Website', url: 'https://example.test' }],
    publicViews: { posts: true, reviews: true, collections: true, realms: false },
    ...(kind === 'organization' ? { speakersListed: false } : {}),
  };
}

/** Interface-only IO. The same editor and cards consume this in Patterns and the real BFF in Pages. */
export function createProfileStoryIO(scenario: ProfileScenario): ProfileEditorIO {
  let current = profileStoryValues(scenario === 'organization' ? 'organization' : 'actor');
  if (scenario === 'empty') current = { ...current, displayName: null, biography: null, avatar: null, links: [] };
  const receipts = new Set<string>();
  let failed = false;
  return {
    read: async () => {
      if (scenario === 'handleless' || (scenario === 'unavailable' && !failed)) {
        failed = true;
        throw new Error('Profile unavailable');
      }
      return structuredClone(current);
    },
    save: async (attempt) => {
      if (scenario === 'pending') await new Promise<void>(() => {});
      if (scenario === 'refused' && !failed) {
        failed = true;
        return { ok: false, status: 403, message: '' };
      }
      if (!receipts.has(attempt.idempotencyKey)) {
        current = rebaseProfile(attempt.before, attempt.after, current);
        receipts.add(attempt.idempotencyKey);
        if (scenario === 'lost') throw new Error('Response lost');
        if (scenario === 'readback') current = { ...current, displayName: 'Changed on another device' };
      }
      return { ok: true, profile: attempt.after };
    },
  };
}

function storyVariant(): string {
  const context = (globalThis as typeof globalThis & { __rezicsStoryContext?: { url?: string } }).__rezicsStoryContext;
  return new URL(context?.url ?? '/settings', 'http://rezics.local').searchParams.get('profile') ?? '';
}

const profile = (id: string, kind: 'actor' | 'organization', variant = '') => ({
  id,
  kind,
  state: 'active' as const,
  automated: false,
  operatorId: null,
  handle: variant.includes('handleless') ? null : kind === 'actor' ? 'reader' : 'reading-club',
  displayName: kind === 'actor' ? 'Avery Reader' : 'Reading Club',
  bio: variant.includes('extended')
    ? 'I collect thoughtful stories and share notes about what I read. '.repeat(12).trim()
    : 'I collect thoughtful stories and share notes about what I read.',
  avatar: variant.includes('extended')
    ? {
        media: 'story-avatar',
        id: 'story-avatar',
        width: 80,
        height: 80,
        placeholder: { thumbhash: '', color: '#d7c8ad' },
        variants: [{ format: 'webp' as const, width: 240 }],
        focalPoint: null,
        credit: null,
      }
    : null,
  links: variant.includes('extended')
    ? ['Website', 'Reading notes', 'Community', 'Portfolio', 'Contact'].map((label, index) => ({
        label,
        url: `https://example.test/${index + 1}`,
      }))
    : [{ label: 'Website', url: 'https://example.test' }],
  publicViews: { posts: true, reviews: true, collections: true, realms: false },
  ...(kind === 'organization' ? { speakersListed: false } : {}),
  verified: false,
  subject: null,
});

type StoryProfile = Omit<ReturnType<typeof profile>, 'displayName' | 'bio'> & {
  displayName: string | null;
  bio: string | null;
};
const records = new Map<string, StoryProfile>();
const receipts = new Set<string>();
function recordFor(variant: string, id: string) {
  const key = `${variant}:${id}`;
  let current = records.get(key);
  if (!current) {
    current = profile(id, variant.includes('organization') ? 'organization' : 'actor', variant);
    records.set(key, current);
  }
  return current;
}
const read: NonNullable<FakeRoute['story']> = ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.has('agent')) return;
  const variant = storyVariant();
  if (variant === 'unavailable') return { status: 503, code: 'dependency_unavailable' };
  const id = url.searchParams.get('ids') ?? (variant.includes('organization') ? 'org-story-viewer' : 'story-viewer');
  return { status: 200, accounts: [recordFor(variant, id)], next: null };
};

export const routes: FakeRoute[] = [
  { method: 'GET', path: '/v1/accounts', story: read, fixture: read },
  {
    method: 'PATCH',
    path: /^\/v1\/accounts\/([^/]+)$/,
    story: async ({ request, match }) => {
      const id = decodeURIComponent(match?.[1] ?? '');
      const variant = storyVariant();
      if (variant === 'refused') return { status: 403, code: 'forbidden' };
      const key = `${variant}:${request.headers.get('idempotency-key')}`;
      const body: unknown = await request.json();
      if (!receipts.has(key) && body && typeof body === 'object') {
        const current = recordFor(variant, id);
        const next = { ...current };
        if ('displayName' in body && (typeof body.displayName === 'string' || body.displayName === null))
          next.displayName = body.displayName;
        if ('biography' in body && (typeof body.biography === 'string' || body.biography === null))
          next.bio = body.biography;
        if ('links' in body && Array.isArray(body.links))
          next.links = body.links.filter(
            (link): link is ProfileLink =>
              !!link && typeof link === 'object' && typeof link.label === 'string' && typeof link.url === 'string',
          );
        if ('publicViews' in body && body.publicViews && typeof body.publicViews === 'object')
          next.publicViews = { ...current.publicViews, ...body.publicViews };
        if ('speakersListed' in body && typeof body.speakersListed === 'boolean' && current.kind === 'organization')
          next.speakersListed = body.speakersListed;
        if ('avatar' in body && body.avatar === null) next.avatar = null;
        else if ('avatar' in body && typeof body.avatar === 'string') {
          const summary = profile(id, current.kind, 'extended').avatar;
          if (summary) next.avatar = { ...summary, media: body.avatar, id: body.avatar };
        }
        records.set(`${variant}:${id}`, next);
        receipts.add(key);
      }
      return { status: 200, accountId: id };
    },
    fixture: () => ({ status: 200, accountId: 'reader' }),
  },
];
