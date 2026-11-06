import { createCommunityWorkModule } from './work.ts';
import { realmViewerActionResource } from './realm.ts';
import { spaceViewerActionResource } from './space.ts';
import type { CommunityAmbient } from './ambient.ts';

export { systemCommunityAmbient, type CommunityAmbient } from './ambient.ts';

/**
 * Community's declared contribution to the Kernel: one value that composition consumes.
 * Constructing it runs nothing; the work module registers only when the work runtime composes it,
 * and the viewer permissions join the HTTP viewer catalogue. Every operand comes from `ambient`.
 */
export function createCommunityDeclaration(ambient: CommunityAmbient) {
  return Object.freeze({
    name: 'community' as const,
    work: createCommunityWorkModule(ambient),
    viewerResources: [
      ['community.realm', realmViewerActionResource],
      ['community.space', spaceViewerActionResource],
    ] as const,
  });
}

export type CommunityDeclaration = ReturnType<typeof createCommunityDeclaration>;
