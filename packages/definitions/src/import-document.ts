import type { Extension } from './extension.ts';
import { EXTENSION_DOCUMENT_FORMAT } from './publication-workspace.ts';
import { publicationLimits, validateRelease } from './index.ts';
import { RELEASE_LIMITS, type Release } from './portable.ts';
import {
  classifyImportedDocument,
  mapReleaseViolations,
  unknownImportedDocumentDiagnostic,
  type PublicationDiagnostic,
  type PublicationDocumentKind,
} from './publication-workspace.ts';

export type CatalogueSourceInput = {
  root: string;
  schemas: Record<string, string>;
  presentation: Record<string, string>;
  contexts?: Record<string, string>;
  filters?: Record<string, string>;
};

export type ImportedCatalogueDocument =
  | { kind: 'invalid'; diagnostics: PublicationDiagnostic[] }
  | { kind: 'release'; release: Release; diagnostics: PublicationDiagnostic[] }
  | { kind: 'sources'; release: Release; sources: CatalogueSourceInput; diagnostics: PublicationDiagnostic[] }
  | { kind: 'extension'; extension: Extension; diagnostics: PublicationDiagnostic[] };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sourceDiagnostics(value: unknown): PublicationDiagnostic[] {
  const diagnostics: PublicationDiagnostic[] = [];
  if (!record(value)) return [{ pointer: '/sources', code: 'invalid_type', file: null }];
  if (typeof value.root !== 'string' || value.root.length === 0 || value.root.length > 256)
    diagnostics.push({ pointer: '/sources/root', code: 'invalid_format', file: null });
  if (!record(value.schemas)) diagnostics.push({ pointer: '/sources/schemas', code: 'invalid_type', file: null });
  else {
    const files = Object.keys(value.schemas);
    if (files.length === 0) diagnostics.push({ pointer: '/sources/schemas', code: 'required', file: null });
    if (files.length > 256) diagnostics.push({ pointer: '/sources/schemas', code: 'out_of_range', file: null });
    for (const file of files.slice(0, 256)) {
      const text = value.schemas[file];
      if (typeof text !== 'string') diagnostics.push({ pointer: `/sources/schemas/${file.replace(/~/g, '~0').replace(/\//g, '~1')}`, code: 'invalid_type', file });
      else if (utf8Bytes(text) > 256 * 1024)
        diagnostics.push({ pointer: `/sources/schemas/${file.replace(/~/g, '~0').replace(/\//g, '~1')}`, code: 'out_of_range', file });
    }
  }
  if (!record(value.presentation)) diagnostics.push({ pointer: '/sources/presentation', code: 'invalid_type', file: null });
  else {
    const files = Object.keys(value.presentation);
    if (files.length > 256) diagnostics.push({ pointer: '/sources/presentation', code: 'out_of_range', file: null });
    for (const file of files.slice(0, 256)) {
      const text = value.presentation[file];
      if (typeof text !== 'string')
        diagnostics.push({
          pointer: `/sources/presentation/${file.replace(/~/g, '~0').replace(/\//g, '~1')}`,
          code: 'invalid_type',
          file,
        });
      else if (utf8Bytes(text) > 256 * 1024)
        diagnostics.push({
          pointer: `/sources/presentation/${file.replace(/~/g, '~0').replace(/\//g, '~1')}`,
          code: 'out_of_range',
          file,
        });
    }
  }
  return diagnostics.slice(0, 64);
}

function catalogueErrorDiagnostics(error: {
  violations: readonly { pointer: string; code: string; file: string }[];
}): PublicationDiagnostic[] {
  return error.violations.slice(0, 64).map((violation) => ({
    pointer: violation.pointer.length > 0 ? violation.pointer : '/',
    code: violation.code,
    file: violation.file,
  }));
}

function releaseDiagnostics(release: unknown): PublicationDiagnostic[] {
  const admission = validateRelease(release);
  if (admission.length) return mapReleaseViolations(admission);
  return mapReleaseViolations(publicationLimits(release));
}

function compactJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Compile or admit one imported catalogue document. Source compilation stays native. */
export async function admitImportedDocument(value: unknown): Promise<ImportedCatalogueDocument> {
  if (value === undefined || value === null) {
    return { kind: 'invalid', diagnostics: [unknownImportedDocumentDiagnostic()] };
  }
  if (compactJsonBytes(value) > RELEASE_LIMITS.bytes) {
    return { kind: 'invalid', diagnostics: [{ pointer: '/document', code: 'out_of_range', file: null }] };
  }
  const kind: PublicationDocumentKind = classifyImportedDocument(value);
  if (kind === 'invalid') return { kind, diagnostics: [unknownImportedDocumentDiagnostic()] };
  if (kind === 'release') {
    const diagnostics = releaseDiagnostics(value);
    return diagnostics.length ? { kind: 'invalid', diagnostics } : { kind, release: value as Release, diagnostics: [] };
  }
  if (kind === 'extension') {
    const extension = value as Extension;
    if (extension.format !== EXTENSION_DOCUMENT_FORMAT) {
      return { kind: 'invalid', diagnostics: [{ pointer: '/extension/format', code: 'invalid_format', file: null }] };
    }
    return { kind, extension, diagnostics: [] };
  }
  const sourceErrors = sourceDiagnostics(value);
  if (sourceErrors.length) return { kind: 'invalid', diagnostics: sourceErrors };
  const sources = value as CatalogueSourceInput;
  const { CatalogueError, compileCatalogue } = await import('./compile.ts');
  try {
    const release = await compileCatalogue(sources);
    const diagnostics = releaseDiagnostics(release);
    return diagnostics.length
      ? { kind: 'invalid', diagnostics }
      : { kind: 'sources', release, sources, diagnostics: [] };
  } catch (error) {
    if (error instanceof CatalogueError) return { kind: 'invalid', diagnostics: catalogueErrorDiagnostics(error) };
    throw error;
  }
}
