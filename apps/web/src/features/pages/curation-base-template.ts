import { platformRegistry, validateProfile, type PresentationProfile } from '@rezics/composition';
import { overviewOf, withTemplate } from './curate';

export function addStructuralBaseTemplate(profile: PresentationProfile, key: string) {
  if (profile.bases.some((entry) => entry.base === key))
    return { ok: false as const, errors: [{ pointer: '/bases', code: 'duplicate' }] };

  const template = { scope: 'base' as const, key };
  const next = withTemplate(profile, template, structuredClone(overviewOf(profile, { scope: 'generic', key: null })!));
  const errors = validateProfile(platformRegistry, next);
  return errors.length ? { ok: false as const, profile: next, errors } : { ok: true as const, profile: next };
}
