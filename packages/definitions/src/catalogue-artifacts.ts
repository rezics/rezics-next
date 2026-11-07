/** Server-side admission over complete immutable Release1 artifacts. */
export * from './catalogue.ts';
export type {
  CatalogueKindLookup,
  CatalogueVerification,
  ResolvedCatalogueType,
} from './compiler/catalogue-artifacts.ts';
export type { CatalogueBuildInput } from './compiler/contract.ts';

import { nativeCompiler } from './adapters/compiler-host.ts';
import type { CatalogueArtifactReader, CatalogueArtifactStore, KindCataloguePin } from './catalogue.ts';
import type { CatalogueKindLookup } from './compiler/catalogue-artifacts.ts';
import type { CatalogueBuildInput } from './compiler/contract.ts';
import type { Release } from './portable.ts';

export function parseKindDeclaration(value: unknown) {
  return nativeCompiler().parseKindDeclaration(value);
}
export function compatibilityKind(release: Release, digest: string, typeId: string) {
  return nativeCompiler().compatibilityKind(release, digest, typeId);
}
export async function buildCatalogue(input: CatalogueBuildInput, store: CatalogueArtifactStore) {
  return nativeCompiler().buildCatalogue(input, store);
}
export async function verifyCatalogue(pin: KindCataloguePin, reader: CatalogueArtifactReader) {
  return nativeCompiler().verifyCatalogue(pin, reader);
}
export async function lookupCatalogueKind(
  pin: KindCataloguePin,
  id: string,
  reader: CatalogueArtifactReader,
): Promise<CatalogueKindLookup> {
  return nativeCompiler().lookupCatalogueKind(pin, id, reader) as Promise<CatalogueKindLookup>;
}
export async function readCatalogueArtifact(reader: CatalogueArtifactReader, digest: string, maximum: number) {
  return nativeCompiler().readCatalogueArtifact(reader, digest, maximum);
}
