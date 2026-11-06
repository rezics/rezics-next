import { admitImportedDocument } from '@rezics/definitions/compile';
import { extensionDigest, validateExtension, type Extension } from '@rezics/definitions/extension';
import {
  closedPublicationOperations,
  compareExtensions,
  compareReleases,
  extensionIdentity,
  grantedPublicationOperations,
  reconcileActivation,
  releaseIdentity,
  type ActivationReconciliation,
  type EditorialHead,
  type ExtensionComparison,
  type PublicationDiagnostic,
  type PublicationIdentity,
  type PublicationOperations,
  type ReleaseComparison,
} from '@rezics/definitions';
import { releaseDigest, type Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { activeRelease, GLOBAL_CONTEXT, readRelease } from './definitions.ts';
import { activeExtension, readPublishedExtension } from './extensions.ts';

export type ImportedPreview = {
  kind: 'release' | 'sources' | 'extension' | 'invalid';
  identity: PublicationIdentity | null;
  diagnostics: PublicationDiagnostic[];
  comparison: ReleaseComparison | ExtensionComparison | null;
  types: { id: string }[];
  current: EditorialHead | null;
  reconciliation: ActivationReconciliation | null;
  operations: PublicationOperations;
  document: Release | Extension | null;
};

function typesOf(release: Release): { id: string }[] {
  return Object.keys(release.types)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((id) => ({ id }));
}

export async function previewImportedDocument(
  pool: Pool,
  document: unknown,
  options: { context?: string; expectedHead?: number | null; admitted: boolean } = { admitted: true },
): Promise<ImportedPreview> {
  const operations = options.admitted
    ? grantedPublicationOperations()
    : closedPublicationOperations();
  const active = await activeRelease(pool);
  const current = active ? { digest: active.digest, head: active.head } : null;
  const admitted = await admitImportedDocument(document);
  if (admitted.kind === 'invalid') {
    return {
      kind: 'invalid',
      identity: null,
      diagnostics: admitted.diagnostics,
      comparison: null,
      types: [],
      current,
      reconciliation: null,
      operations,
      document: null,
    };
  }
  if (admitted.kind === 'extension') {
    const context = options.context ?? admitted.extension.context;
    const base = active;
    if (!base) {
      return {
        kind: 'invalid',
        identity: null,
        diagnostics: [{ pointer: '/extension', code: 'unsupported', file: null }],
        comparison: null,
        types: [],
        current,
        reconciliation: null,
        operations,
        document: null,
      };
    }
    const violations = validateExtension(admitted.extension, base.release, { context });
    if (violations.length) {
      return {
        kind: 'invalid',
        identity: null,
        diagnostics: violations.slice(0, 64).map((violation) => ({
          pointer: `/extension${violation.pointer}`,
          code: violation.code,
          file: null,
        })),
        comparison: null,
        types: [],
        current,
        reconciliation: null,
        operations,
        document: null,
      };
    }
    const digest = extensionDigest(admitted.extension);
    const existing = context === GLOBAL_CONTEXT ? null : await activeExtension(pool, context);
    return {
      kind: 'extension',
      identity: extensionIdentity(digest),
      diagnostics: [],
      comparison: compareExtensions(existing?.extension ?? null, admitted.extension),
      types: [],
      current: existing ? { digest: existing.digest, head: existing.head } : current,
      reconciliation: reconcileActivation(digest, existing ? { digest: existing.digest, head: existing.head } : null, options.expectedHead ?? null),
      operations,
      document: admitted.extension,
    };
  }
  const release = admitted.release;
  const digest = releaseDigest(release);
  return {
    kind: admitted.kind,
    identity: releaseIdentity(digest, release),
    diagnostics: [],
    comparison: active ? compareReleases(active.release, release) : compareReleases({ types: {}, properties: {} }, release),
    types: typesOf(release),
    current,
    reconciliation: reconcileActivation(digest, current, options.expectedHead ?? null),
    operations,
    document: release,
  };
}

export async function readPublishedRelease(pool: Pool, digest: string): Promise<{ digest: string; release: Release } | null> {
  const release = await readRelease(pool, digest, { composed: false });
  return release ? { digest, release } : null;
}

export async function readPublishedExtensionBody(
  pool: Pool,
  context: string,
  digest: string,
): Promise<{ digest: string; extension: Extension } | null> {
  const extension = await readPublishedExtension(pool, context, digest);
  return extension ? { digest, extension } : null;
}
