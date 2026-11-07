import {
  compatibilityKind,
  lookupCatalogueKind,
  parseKindDeclaration,
  readCatalogueArtifact,
  buildCatalogue,
  verifyCatalogue,
} from './catalogue-artifacts.ts';
import { admitImportedDocument, compileCatalogue } from './catalogue-compile.ts';
import type { CompilerApplication, CompilerHost } from './contract.ts';
import { releaseAdmission, validateRelease } from './release-validation.ts';

export type { CompilerApplication, CompilerHost } from './contract.ts';
export { CatalogueError } from './catalogue-compile.ts';
export type { CatalogueViolation, CatalogueSourceInput, CatalogueBuildInput } from './contract.ts';
export type { ImportedCatalogueDocument } from '../import-document.ts';
export type { CatalogueKindLookup, CatalogueVerification, ResolvedCatalogueType } from './catalogue-artifacts.ts';

/**
 * One compiler use-case object. Nested nonempty Filter, pattern and catalogue operations close over this host.
 * Creating another compiler does not replace this instance.
 */
export function createCompilerApplication(host: CompilerHost): CompilerApplication {
  return Object.freeze({
    releaseAdmission,
    validateRelease: (value: unknown) => validateRelease(value, host),
    compileCatalogue: (input) => compileCatalogue(input, host),
    admitImportedDocument: (value: unknown) => admitImportedDocument(value, host),
    parseKindDeclaration: (value: unknown) => parseKindDeclaration(value, host),
    buildCatalogue: (input, store) => buildCatalogue(input, store, host),
    verifyCatalogue: (pin, reader) => verifyCatalogue(pin, reader, host),
    lookupCatalogueKind: (pin, id, reader) => lookupCatalogueKind(pin, id, reader, host),
    readCatalogueArtifact,
    compatibilityKind: (release, digest, typeId) => compatibilityKind(release, digest, typeId, host),
  });
}

export {
  admitImportedDocument,
  compileCatalogue,
  releaseAdmission,
  validateRelease,
  buildCatalogue,
  verifyCatalogue,
  lookupCatalogueKind,
  parseKindDeclaration,
  readCatalogueArtifact,
  compatibilityKind,
};
