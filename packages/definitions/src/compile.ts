import { nativeCompiler } from './adapters/compiler-host.ts';
import { CatalogueError } from './compiler/catalogue-compile.ts';
import type { CatalogueSourceInput, CatalogueViolation } from './compiler/contract.ts';
import type { ImportedCatalogueDocument } from './import-document.ts';

export { CatalogueError };
export type { CatalogueSourceInput, CatalogueViolation, ImportedCatalogueDocument };

export function compileCatalogue(input: CatalogueSourceInput) {
  return nativeCompiler().compileCatalogue(input);
}

export function admitImportedDocument(value: unknown) {
  return nativeCompiler().admitImportedDocument(value) as Promise<ImportedCatalogueDocument>;
}
