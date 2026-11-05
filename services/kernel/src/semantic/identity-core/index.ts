/** Semantic-owned pure canonical identity; no native authority. */
export * from './values.ts';
export * from './mapping.ts';
export * from './encoding.ts';
export {
  identityEpochChangeTerminal,
  classifyIdentityRemainder,
  type IdentityEpochLibraryTransform,
  type IdentityTransformSource,
  type IdentityRemainder,
} from './transforms.ts';
