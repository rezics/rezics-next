import { accountProfileEditing } from '@rezics/client';
import type { FakeRoute } from '../fake-modules.ts';
import { observeProfile, type ProfileLink, type ProfileValues } from '../../settings/profile-data';
import type { EditableProfile } from '../../settings/editable-profile-source';
import { rebaseProfile, type ProfileEditorIO } from '../../settings/profile-write';
import { storyViewerId } from './identities';

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
  return observeProfile({
    accountId: kind === 'actor' ? 'story-viewer' : 'org-story-viewer',
    kind,
    displayName: kind === 'actor' ? 'Avery Reader' : 'Reading Club',
    biography: 'I collect thoughtful stories and share notes about what I read.',
    avatar: null,
    links: [{ label: 'Website', url: 'https://example.test' }],
    publicViews: { posts: true, reviews: true, collections: true, realms: false },
    ...(kind === 'organization' ? { speakersListed: false } : {}),
  });
}

/** Interface-only IO. The same editor and cards consume this in Patterns and the real BFF in Pages. */
export function createProfileStoryIO(scenario: ProfileScenario): ProfileEditorIO {
  let current = profileStoryValues(scenario === 'organization' ? 'organization' : 'actor');
  if (scenario === 'empty') current = { ...current, displayName: null, biography: null, avatar: null, links: [] };
  const receipts = new Set<string>();
  let failed = false;
  return {
    read: async () => {
      if (scenario === 'unavailable' && !failed) {
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

const profileVariants = new Set([
  '',
  'self',
  'normal',
  'empty',
  'organization',
  'extended',
  'organization-extended',
  'pending',
  'lost',
  'refused',
  'unavailable',
  'handleless',
  'readback',
]);

function settingsProfileVariant(): string | undefined {
  const context = (
    globalThis as typeof globalThis & {
      __rezicsStoryContext?: { visitor?: string; url?: string };
    }
  ).__rezicsStoryContext;
  if (context?.visitor !== 'Signed In' || !context.url) return;

  let page: URL;
  try {
    page = new URL(context.url, 'http://rezics.local');
  } catch {
    return;
  }
  const pathname = page.pathname.replace(/^\/[a-z]{2}(?:-[a-z0-9]{2,8})?(?=\/)/i, '');
  if ((pathname !== '/settings' && pathname !== '/settings/') || page.searchParams.has('managedAccount')) return;

  const selected = page.searchParams.getAll('profile');
  if (selected.length > 1 || (selected.length === 1 && !selected[0])) return;
  const variant = selected[0] ?? '';
  if (!profileVariants.has(variant)) return;
  return variant;
}

function selectedProfileId(request: Request, match?: RegExpExecArray | null): string | undefined {
  if (settingsProfileVariant() === undefined) return;
  const url = new URL(request.url);
  if (url.search) return;
  try {
    return decodeURIComponent(match?.[1] ?? '') === storyViewerId ? storyViewerId : undefined;
  } catch {
    return;
  }
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
        variants: [{ format: 'webp' as const, width: 80 }],
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
  const variant = settingsProfileVariant();
  if (variant === undefined) return;
  const ids = url.searchParams.getAll('ids');
  if (url.searchParams.size !== 1 || ids.length !== 1 || ids[0] !== storyViewerId) return;
  if (variant === 'unavailable') return { status: 503, code: 'dependency_unavailable' };
  return { status: 200, accounts: [recordFor(variant, storyViewerId)], next: null };
};

const readEditable: NonNullable<FakeRoute['story']> = ({ request, match }) => {
  const id = selectedProfileId(request, match);
  if (!id) return;
  const variant = settingsProfileVariant()!;
  if (variant === 'unavailable') return { status: 503, code: 'dependency_unavailable' };
  const current = recordFor(variant, id);
  const profile: EditableProfile = {
    id: current.id,
    kind: current.kind,
    handle: current.handle,
    displayName: current.displayName,
    bio: current.bio,
    links: current.links,
    avatar: current.avatar
      ? {
          media: current.avatar.media,
          width: current.avatar.width,
          height: current.avatar.height,
          placeholder: current.avatar.placeholder,
          variants: current.avatar.variants,
          focalPoint: current.avatar.focalPoint,
          credit: current.avatar.credit,
        }
      : null,
    publicViews: current.publicViews,
    ...(typeof current.speakersListed === 'boolean' ? { speakersListed: current.speakersListed } : {}),
  };
  return {
    status: 200,
    profile,
    editing: accountProfileEditing(id, { id, kind: profile.kind }),
  };
};

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/accounts\/([^/]+)\/profile$/,
    story: readEditable,
    fixture: readEditable,
  },
  { method: 'GET', path: '/v1/accounts', story: read, fixture: read },
  {
    method: 'PATCH',
    path: /^\/v1\/accounts\/([^/]+)$/,
    story: async ({ request, match }) => {
      const id = selectedProfileId(request, match);
      if (!id) return;
      const variant = settingsProfileVariant()!;
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
    fixture: ({ request, match }) => {
      const id = selectedProfileId(request, match);
      return id ? { status: 200, accountId: id } : undefined;
    },
  },
];
