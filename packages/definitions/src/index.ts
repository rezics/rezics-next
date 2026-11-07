/// <reference path="./recheck.d.ts" />
export * from './portable.ts';
export * from './publication-workspace.ts';
export { publicationLimits, PUBLICATION_LIMITS } from './publication-construction.ts';
export { chooseLabel, languageRanges } from './language.ts';
export {
  buildCatalogue,
  compatibilityKind,
  lookupCatalogueKind,
  parseKindDeclaration,
  readCatalogueArtifact,
  verifyCatalogue,
} from './catalogue-artifacts.ts';
export type { CatalogueKindLookup, CatalogueVerification, ResolvedCatalogueType } from './catalogue-artifacts.ts';
export type { CatalogueBuildInput } from './compiler/contract.ts';

import { nativeCompiler } from './adapters/compiler-host.ts';

export function releaseAdmission(value: unknown) {
  return nativeCompiler().releaseAdmission(value);
}
export function validateRelease(value: unknown) {
  return nativeCompiler().validateRelease(value);
}
