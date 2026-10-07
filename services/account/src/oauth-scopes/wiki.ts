/** Account attests Wiki owner operations; Access admits each exact resource scope. */
export const oauthScopes = ['zone:edit', 'collection:edit', 'semantic:read', 'wiki:propose'] as const;

/** Zone and collection edits and semantic reads also serve public routes. */
export const closedGroupScopes = ['wiki:propose'] as const;
