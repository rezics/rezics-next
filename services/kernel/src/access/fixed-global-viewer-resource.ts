import { authoritativeTimeValue } from '../command/command.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import type { ParentAnchor } from './parent-creation.ts';
import type { ViewerActionResource } from './viewer-actions.ts';

/** Existence only, borrowed from Semantic's native Global anchor. Ordinary Context
 * read eligibility and each action's Access formula remain separate decisions. */
export function fixedGlobalViewerResource(anchor: ParentAnchor): ViewerActionResource {
  if (anchor.resource.route !== PLATFORM_RESOURCE.route || anchor.resource.id !== PLATFORM_RESOURCE.id)
    throw new TypeError('Fixed Global viewer resource requires the canonical Global Context anchor');
  return Object.freeze({
    readAction: 'context:read',
    async read(client, ids, at, time) {
      // Reject missing, forged or expired T before any native IO. Never mint from at.
      if (!time || authoritativeTimeValue(time) !== at)
        throw new TypeError('Fixed Global viewer resource requires the live viewer read time');
      if (!ids.includes(PLATFORM_RESOURCE.id)) return {};
      return (await anchor.validate(client, time)) ? { [PLATFORM_RESOURCE.id]: true } : {};
    },
  });
}
