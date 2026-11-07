/** Append versions; never change a list used by a recorded erasure. */
export const ERASURE_PARTICIPANTS = Object.freeze({
  1: Object.freeze([
    'access',
    'auth',
    'library',
    'commerce',
    'content',
    'community',
    'semantic',
    'search',
    'imports',
    'shared-history',
    'delivery',
  ] as const),
});
