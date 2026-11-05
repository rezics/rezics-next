import { memoizedValue } from '../memoized.ts';
import { type PresentationProfile } from '@rezics/composition';
import profile from '@rezics/composition/profiles/platform.json' with { type: 'json' };
import type { Pool } from 'pg';
import { bootstrapProfile } from './profiles.ts';

/** Shipped presentation profile. The same document is `@rezics/composition/profiles/platform.json`. */
export function platformProfile() {
  return memoizedValue(platformProfile, () => profile as PresentationProfile);
}

/** Activate the platform profile. An active profile stays in place: one pointer read. */
export function setupPresentation(pool: Pool): Promise<string> {
  return bootstrapProfile(pool, platformProfile());
}
