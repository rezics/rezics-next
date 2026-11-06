import {
  classifyImportedDocument,
  diagnosticField,
  isPublicationDigest,
  PUBLICATION_GRANT,
  PUBLICATION_LOCALES,
  unknownImportedDocumentDiagnostic,
  type ActivationReconciliation,
  type EditorialHead,
  type ExtensionComparison,
  type PublicationDiagnostic,
  type PublicationDocumentKind,
  type PublicationIdentity,
  type PublicationLocale,
  type PublicationOperations,
  type ReleaseComparison,
} from '@rezics/definitions';

export const publicationPageSize = 20;
export const publicationFileLimit = 4_194_304;
export type PublicationJson =
  | null
  | boolean
  | number
  | string
  | PublicationJson[]
  | { [key: string]: PublicationJson };
export type PublicationDocument = { [key: string]: PublicationJson };
export type PublicationFailure =
  | 'signed-out'
  | 'denied'
  | 'closed'
  | 'invalid'
  | 'unavailable'
  | 'conflict'
  | 'stale'
  | 'uncertain'
  | 'missing';
export type PublicationPhase =
  | 'closed'
  | 'idle'
  | 'review'
  | 'invalid'
  | 'publishing'
  | 'uncertain'
  | 'building'
  | 'ready'
  | 'reconciling'
  | 'activating'
  | 'completed';
export type PublicationScope = 'platform' | 'context';
export type CatalogueBuildState = 'building' | 'incomplete' | 'refused' | 'ready';
export type CatalogueBuildStatus = {
  pin: { rootDigest: string };
  state: CatalogueBuildState;
  phase: 'node' | 'release' | 'declaration';
  steps: string;
  missing_digest: string | null;
  error: string | null;
};
export type PublicationPreview = {
  kind: PublicationDocumentKind;
  identity: PublicationIdentity | null;
  diagnostics: PublicationDiagnostic[];
  comparison: ReleaseComparison | ExtensionComparison | null;
  types: { id: string }[];
  current: EditorialHead | null;
  reconciliation: ActivationReconciliation | null;
  operations: PublicationOperations;
  document: PublicationDocument | null;
};
export type PublicationCommand = {
  key: string;
  operation: 'publish' | 'activate' | 'build' | 'step';
  body: PublicationDocument;
  path: string;
};
export type PublicationResult = {
  digest: string;
  head?: number;
  pin?: { rootDigest: string };
};
export type PublicationRead =
  | { ok: false; reason: PublicationFailure }
  | {
      ok: true;
      phase: PublicationPhase;
      scope: PublicationScope;
      operations: PublicationOperations;
      current: EditorialHead | null;
      context?: string;
    };
export type PublicationTransport = {
  open: (scope: PublicationScope, context?: string) => Promise<PublicationRead>;
  preview: (
    document: PublicationDocument,
    context?: string,
    expectedHead?: number | null,
  ) => Promise<PublicationPreview | { ok: false; reason: PublicationFailure }>;
  submit: (
    command: PublicationCommand,
  ) => Promise<
    | { ok: true; status: number; result: PublicationResult }
    | { ok: false; reason: PublicationFailure; expectedHead?: number }
  >;
  readRelease: (digest: string) => Promise<{ ok: true; digest: string } | { ok: false; reason: PublicationFailure }>;
  readExtension: (
    context: string,
    digest: string,
  ) => Promise<{ ok: true; digest: string } | { ok: false; reason: PublicationFailure }>;
  readBuild: (root: string) => Promise<CatalogueBuildStatus | { ok: false; reason: PublicationFailure }>;
  createSubject: (
    type: string,
    key: string,
  ) => Promise<{ ok: true; id: string } | { ok: false; reason: PublicationFailure }>;
  readSubject: (
    id: string,
  ) => Promise<{ ok: true; id: string; type: string } | { ok: false; reason: PublicationFailure }>;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function publicationDocument(value: unknown): PublicationDocument | null {
  return record(value) ? (value as PublicationDocument) : null;
}

export function publicationHref(locale: string, scope: PublicationScope = 'platform', context?: string): string {
  const query = new URLSearchParams();
  if (scope === 'context' && context) query.set('context', context);
  return `/${locale}/catalogue/definitions/publish${query.size ? `?${query}` : ''}`;
}

export function quotedPublicationKey(key: string): string {
  return JSON.stringify(key);
}

export function newPublicationKey(): string {
  return crypto.randomUUID();
}

export function isPublicationLocale(value: unknown): value is PublicationLocale {
  return typeof value === 'string' && (PUBLICATION_LOCALES as readonly string[]).includes(value);
}

export function parseImportedText(
  name: string,
  text: string,
): { document: PublicationDocument } | { diagnostics: PublicationDiagnostic[] } {
  if (text.length > publicationFileLimit)
    return { diagnostics: [{ pointer: '/document', code: 'out_of_range', file: name }] };
  const trimmed = text.trim();
  if (!trimmed) return { diagnostics: [unknownImportedDocumentDiagnostic()] };
  try {
    const parsed = publicationDocument(JSON.parse(trimmed) as unknown);
    if (!parsed) return { diagnostics: [unknownImportedDocumentDiagnostic()] };
    if (classifyImportedDocument(parsed) === 'invalid' && !name.endsWith('.yaml') && !name.endsWith('.yml')) {
      return { diagnostics: [unknownImportedDocumentDiagnostic()] };
    }
    return { document: parsed };
  } catch {
    if (name.endsWith('.yaml') || name.endsWith('.yml')) {
      return {
        document: {
          root: name,
          schemas: { [name]: text },
          presentation: {},
        },
      };
    }
    return { diagnostics: [{ pointer: '/document', code: 'invalid_format', file: name }] };
  }
}

export function previewFailure(status: number, code?: string): PublicationFailure {
  if (status === 401) return 'denied';
  if (status === 403) return code === 'platform_closed' ? 'closed' : 'denied';
  if (status === 404) return 'missing';
  if (status === 409) return 'stale';
  if (status === 422) return 'conflict';
  if (status === 400) return 'invalid';
  return 'unavailable';
}

export function commandPath(
  scope: PublicationScope,
  operation: PublicationCommand['operation'],
  identity: PublicationIdentity | null,
  context?: string,
): string {
  if (operation === 'build') return '/v1/definitions/catalogues';
  if (operation === 'step' && identity) return `/v1/definitions/catalogues/${identity.digest}:step`;
  if (scope === 'context' && context && identity && operation === 'activate')
    return `/v1/contexts/${context}/definitions/extensions/${identity.digest}:activate`;
  if (scope === 'context' && context && operation === 'publish')
    return `/v1/contexts/${context}/definitions/extensions`;
  if (operation === 'activate' && identity) return `/v1/definitions/releases/${identity.digest}:activate`;
  return '/v1/definitions/releases';
}

export function publishBody(
  kind: PublicationDocumentKind,
  document: PublicationJson,
  context?: string,
): PublicationDocument {
  if (kind === 'extension') return { extension: document };
  if (kind === 'sources' || kind === 'release') return { release: document };
  return context ? { extension: document } : { release: document };
}

export function activateBody(expectedHead: number | null): { expected_head: number | null } {
  return { expected_head: expectedHead };
}

export function isReleaseComparison(value: ReleaseComparison | ExtensionComparison | null): value is ReleaseComparison {
  return Boolean(value && 'addedTypes' in value);
}

export function isExtensionComparison(
  value: ReleaseComparison | ExtensionComparison | null,
): value is ExtensionComparison {
  return Boolean(value && 'addedTerms' in value);
}

export function repairableDiagnostics(diagnostics: readonly PublicationDiagnostic[]): PublicationDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnosticField(diagnostic).length > 0).slice(0, 64);
}

export function workspacePhase(input: {
  operations?: PublicationOperations | null;
  preview?: PublicationPreview | null;
  publishing?: boolean;
  activating?: boolean;
  uncertain?: boolean;
  stale?: boolean;
  build?: CatalogueBuildStatus | null;
  completed?: PublicationResult | null;
}): PublicationPhase {
  if (!input.operations?.admitted) return 'closed';
  if (input.uncertain) return 'uncertain';
  if (input.completed) return 'completed';
  if (input.activating) return 'activating';
  if (input.stale) return 'reconciling';
  if (input.build && (input.build.state === 'building' || input.build.state === 'incomplete')) return 'building';
  if (input.publishing) return 'publishing';
  if (input.preview?.kind === 'invalid' || (input.preview && input.preview.diagnostics.length > 0)) return 'invalid';
  if (input.preview?.identity && isPublicationDigest(input.preview.identity.digest)) return 'ready';
  if (input.preview) return 'review';
  return 'idle';
}

export { PUBLICATION_GRANT, diagnosticField, isPublicationDigest };
export type { PublicationDiagnostic, PublicationIdentity, PublicationLocale, PublicationOperations };
