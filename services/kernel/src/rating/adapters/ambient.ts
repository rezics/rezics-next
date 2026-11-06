import { randomBytes } from 'node:crypto';
import { systemClock } from '../../clock.ts';
import { newId } from '../../route/route.ts';
import type { RatingAmbient, RatingCapabilities, RatingCapabilityOptions } from '../contract/capabilities.ts';

/** Compatibility for direct adapter callers; it does not construct the command or work libraries. */
export function ratingCapabilities(options: RatingCapabilityOptions): RatingAmbient & Partial<RatingCapabilities> {
  return (
    options.capabilities ?? {
      clock: options.clock ?? systemClock,
      id: newId,
      randomBytes,
    }
  );
}
