import type {
  KindCataloguePin,
  KindDeclarationV1,
  CatalogueArtifactReader,
  CatalogueArtifactStore,
  DefinitionTypePin,
} from '../catalogue.ts';
import type { Release, ReleaseViolation } from '../portable.ts';

/** Filter admission issue. Shape matches Filter's validator; Filter owns the grammar. */
export type CompilerFilterIssue = {
  pointer: string;
  problem: string;
  code: string;
};

/** One construction over a release snapshot. Filter owns parse/admit; this is the compiler port. */
export type CompilerFilterConstruction = {
  validateFilter(input: unknown, options?: { saved?: boolean }): readonly CompilerFilterIssue[];
  qualifiers(property: string): ReadonlySet<string>;
};

export type CatalogueViolation = {
  file: string;
  pointer: string;
  code: 'unsupported' | 'invalid' | 'limit' | 'unsafe_pattern' | 'linkml' | 'duplicate' | 'missing_label';
  message: string;
};

export type CatalogueSourceInput = {
  root: string;
  schemas: Record<string, string>;
  presentation: Record<string, string>;
  contexts?: Record<string, string>;
  filters?: Record<string, string>;
};

export type CatalogueBuildInput = Readonly<{
  releases: Iterable<unknown>;
  declarations?: Iterable<unknown>;
  compatibility?: 'all' | Iterable<DefinitionTypePin>;
}>;

export type BundledCatalogueSources = CatalogueSourceInput & {
  schemas: Record<string, string>;
};

/**
 * Host capabilities for executable compilation, catalogue loading and safe-pattern evaluation.
 * Filter admission is this port, not a contract-layer Filter import.
 */
export type CompilerHost = {
  posixJoin(...parts: string[]): string;
  posixDirname(path: string): string;
  posixBasename(path: string): string;
  posixNormalize(path: string): string;
  posixRelative(from: string, to: string): string;
  yamlParse(text: string): unknown;
  safePattern(pattern: unknown): boolean;
  filterConstruction(release: unknown): CompilerFilterConstruction;
  parseFilter(input: unknown): unknown;
  walkFilter(document: unknown): IterableIterator<unknown>;
};

export type CatalogueFileHost = {
  readDirectory(url: URL): { name: string; isDirectory(): boolean; isFile(): boolean }[];
  readText(url: URL): string;
};

export type CompilerApplication = {
  releaseAdmission(value: unknown): ReleaseViolation[];
  validateRelease(value: unknown): ReleaseViolation[];
  compileCatalogue(input: CatalogueSourceInput): Promise<Release>;
  admitImportedDocument(value: unknown): Promise<unknown>;
  parseKindDeclaration(value: unknown): KindDeclarationV1;
  buildCatalogue(input: CatalogueBuildInput, store: CatalogueArtifactStore): Promise<KindCataloguePin>;
  verifyCatalogue(
    pin: KindCataloguePin,
    reader: CatalogueArtifactReader,
  ): Promise<{ catalogue: KindCataloguePin; nodes: number; releases: number; declarations: number }>;
  lookupCatalogueKind(
    pin: KindCataloguePin,
    id: string,
    reader: CatalogueArtifactReader,
  ): Promise<{ status: 'not-found' | 'found' }>;
  readCatalogueArtifact(reader: CatalogueArtifactReader, digest: string, maximum: number): Promise<unknown>;
  compatibilityKind(release: Release, digest: string, typeId: string): KindDeclarationV1;
};
