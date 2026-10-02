import type { MediaImageViewer } from '@rezics/ui/media-image';

export const anonymousMediaViewer: MediaImageViewer = {
  ready: true, signedIn: false, age: 'unknown', nsfwDisplay: 'mask',
  optIns: { general: true, r15: false, sexual: false, grotesque: false },
};

/** Account owns eligibility; browser presentation consumes only its derived state. */
export function mediaViewer(value: unknown): MediaImageViewer | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const categories = item.categories as Record<string, unknown> | null;
  if (!['unknown', 'under-15', '15-17', 'adult'].includes(String(item.age))
    || typeof item.accountEligible !== 'boolean' || typeof item.adultAvailable !== 'boolean'
    || !categories || ['general', 'r15', 'r18', 'r18g'].some(key => typeof categories[key] !== 'boolean')
    || item.nsfwDisplay !== undefined && !['mask', 'show'].includes(String(item.nsfwDisplay))) return null;
  return {
    ready: true, signedIn: true, age: item.age as MediaImageViewer['age'],
    nsfwDisplay: item.nsfwDisplay === 'show' ? 'show' : 'mask',
    optIns: {
      general: categories.general as boolean,
      r15: item.accountEligible && categories.r15 as boolean,
      sexual: item.accountEligible && item.adultAvailable && categories.r18 as boolean,
      grotesque: item.accountEligible && item.adultAvailable && categories.r18g as boolean,
    },
  };
}

export async function readMediaViewer(input: {
  accountOrigin: string; accessToken?: string; fetch?: typeof fetch;
}): Promise<MediaImageViewer> {
  if (!input.accessToken) return anonymousMediaViewer;
  try {
    const response = await (input.fetch ?? fetch)(new URL('/api/account/content-preferences', input.accountOrigin), {
      headers: { authorization: `Bearer ${input.accessToken}` }, cache: 'no-store',
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    const viewer = response.ok ? mediaViewer(await response.json()) : null;
    if (viewer) return viewer;
  } catch { /* Unavailable account state must not briefly reveal managed images. */ }
  return { ...anonymousMediaViewer, ready: false, signedIn: true };
}
