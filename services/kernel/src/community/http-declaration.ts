import { NATIVE_CONTAINER_ACTIONS } from './actions.ts';
import { realmViewerActionResource } from './realm.ts';
import { communityRoutes, type CommunityRouteDependencies } from './routes.ts';
import { spaceViewerActionResource } from './space.ts';
import type { CommunityAmbient } from './ambient.ts';

/**
 * Community's HTTP-side declaration: routes, viewer permissions and native container actions.
 * It sits apart from the worker declaration, so workers never load the route module. The routes
 * mount takes its request deadline clock from the same ambient as the worker and membership readers.
 */
export function createCommunityHttpDeclaration(ambient: CommunityAmbient) {
  return Object.freeze({
    name: 'community' as const,
    ambient,
    actions: NATIVE_CONTAINER_ACTIONS,
    viewerResources: [
      ['community.realm', realmViewerActionResource],
      ['community.space', spaceViewerActionResource],
    ] as const,
    routes(
      app: Parameters<typeof communityRoutes>[0],
      dependencies: Omit<CommunityRouteDependencies, keyof CommunityAmbient>,
    ) {
      return communityRoutes(app, { ...dependencies, ...ambient });
    },
  });
}

export type CommunityHttpDeclaration = ReturnType<typeof createCommunityHttpDeclaration>;
