import { RELEASE_FORMAT, type Release } from './portable.ts';

export const EXTENSION_DOCUMENT_FORMAT = 'https://rezics.com/definitions/extension/1';

export const PUBLICATION_GRANT = 'definition_publication' as const;
export const PUBLICATION_DIGEST = /^sha256:[a-f0-9]{64}$/;
export const PUBLICATION_LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
export type PublicationLocale = (typeof PUBLICATION_LOCALES)[number];
export type PublicationDocumentKind = 'release' | 'sources' | 'extension' | 'invalid';
export type PublicationDiagnostic = {
  pointer: string;
  code: string;
  file: string | null;
};
export type PublicationIdentity = {
  digest: string;
  version: string | null;
  format: string;
};
export type ReleaseComparison = {
  addedTypes: string[];
  removedTypes: string[];
  changedTypes: string[];
  addedProperties: string[];
  removedProperties: string[];
  changedProperties: string[];
};
export type ExtensionComparison = {
  addedTerms: string[];
  removedTerms: string[];
  changedTerms: string[];
};
export type PublicationOperations = {
  grant: typeof PUBLICATION_GRANT;
  admitted: boolean;
  publish: boolean;
  activate: boolean;
  build: boolean;
};
export type EditorialHead = { digest: string; head: number };
export type ActivationReconciliation = {
  intended: string;
  current: EditorialHead | null;
  stale: boolean;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (left: readonly string[], right: readonly string[]) => {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
};
const sorted = (values: Iterable<string>) => [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
const ownKeys = (value: unknown) => (record(value) ? Object.keys(value) : []);
const pointer = (base: string, key: string) => `${base}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;

export function isPublicationDigest(value: unknown): value is string {
  return typeof value === 'string' && PUBLICATION_DIGEST.test(value);
}

export function classifyImportedDocument(value: unknown): PublicationDocumentKind {
  if (!record(value)) return 'invalid';
  if (value.format === RELEASE_FORMAT && record(value.types) && record(value.properties)) return 'release';
  if (value.format === EXTENSION_DOCUMENT_FORMAT && typeof value.context === 'string' && record(value.terms))
    return 'extension';
  if (typeof value.root === 'string' && record(value.schemas) && record(value.presentation)) return 'sources';
  return 'invalid';
}

export function importedDocumentPointer(kind: PublicationDocumentKind): string {
  if (kind === 'release') return '/release';
  if (kind === 'extension') return '/extension';
  if (kind === 'sources') return '/sources';
  return '/document';
}

export function unknownImportedDocumentDiagnostic(): PublicationDiagnostic {
  return { pointer: '/document', code: 'invalid_type', file: null };
}

function typeShape(definition: unknown) {
  if (!record(definition)) return null;
  return {
    properties: Array.isArray(definition.properties) ? definition.properties.filter((id) => typeof id === 'string') : [],
    bases: Array.isArray(definition.bases) ? definition.bases.filter((id) => typeof id === 'string') : [],
    facets: Array.isArray(definition.facets) ? definition.facets.filter((id) => typeof id === 'string') : [],
  };
}

function propertyShape(definition: unknown) {
  if (!record(definition)) return null;
  return {
    datatype: typeof definition.datatype === 'string' ? definition.datatype : '',
    multivalued: definition.multivalued === true,
    targets: Array.isArray(definition.targets) ? definition.targets.filter((id) => typeof id === 'string') : [],
    units: Array.isArray(definition.units) ? definition.units.filter((id) => typeof id === 'string') : [],
    qualifiers: Array.isArray(definition.qualifiers)
      ? definition.qualifiers.filter((id) => typeof id === 'string')
      : [],
    disclosure: definition.disclosure === 'sourceOrConsent' ? 'sourceOrConsent' : null,
  };
}

function termShape(definition: unknown) {
  if (!record(definition)) return null;
  const relation = record(definition.relation) ? definition.relation : {};
  return {
    domain: Array.isArray(definition.domain) ? definition.domain.filter((id) => typeof id === 'string') : [],
    targets: Array.isArray(definition.targets) ? definition.targets.filter((id) => typeof id === 'string') : [],
    multivalued: definition.multivalued === true,
    group: typeof relation.group === 'string' ? relation.group : '',
    inverse: typeof relation.inverse === 'string' ? relation.inverse : null,
    symmetric: relation.symmetric === true,
  };
}

function collectionDelta(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  same: (left: unknown, right: unknown) => boolean,
) {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const currentKeys = new Set(Object.keys(current));
  const nextKeys = new Set(Object.keys(next));
  for (const key of sorted(nextKeys)) {
    if (!currentKeys.has(key)) added.push(key);
    else if (!same(current[key], next[key])) changed.push(key);
  }
  for (const key of sorted(currentKeys)) if (!nextKeys.has(key)) removed.push(key);
  return { added, removed, changed };
}

/** Semantic identifiers only; localized labels never count as a definition change. */
export function compareReleases(current: Pick<Release, 'types' | 'properties'>, next: Pick<Release, 'types' | 'properties'>): ReleaseComparison {
  const types = collectionDelta(current.types, next.types, (left, right) => {
    const a = typeShape(left);
    const b = typeShape(right);
    return Boolean(a && b && strings(a.properties, b.properties) && strings(a.bases, b.bases) && strings(a.facets, b.facets));
  });
  const properties = collectionDelta(current.properties, next.properties, (left, right) => {
    const a = propertyShape(left);
    const b = propertyShape(right);
    return Boolean(
      a &&
        b &&
        a.datatype === b.datatype &&
        a.multivalued === b.multivalued &&
        a.disclosure === b.disclosure &&
        strings(a.targets, b.targets) &&
        strings(a.units, b.units) &&
        strings(a.qualifiers, b.qualifiers),
    );
  });
  return {
    addedTypes: types.added,
    removedTypes: types.removed,
    changedTypes: types.changed,
    addedProperties: properties.added,
    removedProperties: properties.removed,
    changedProperties: properties.changed,
  };
}

export function compareExtensions(current: { terms?: unknown } | null, next: { terms?: unknown }): ExtensionComparison {
  const left = record(current?.terms) ? current.terms : {};
  const right = record(next.terms) ? next.terms : {};
  const delta = collectionDelta(left, right, (a, b) => {
    const x = termShape(a);
    const y = termShape(b);
    return Boolean(
      x &&
        y &&
        x.multivalued === y.multivalued &&
        x.group === y.group &&
        x.inverse === y.inverse &&
        x.symmetric === y.symmetric &&
        strings(x.domain, y.domain) &&
        strings(x.targets, y.targets),
    );
  });
  return { addedTerms: delta.added, removedTerms: delta.removed, changedTerms: delta.changed };
}

export function reconcileActivation(intended: string, current: EditorialHead | null, expectedHead: number | null): ActivationReconciliation {
  return {
    intended,
    current,
    stale: current !== null && expectedHead !== null && current.head !== expectedHead,
  };
}

export function closedPublicationOperations(): PublicationOperations {
  return { grant: PUBLICATION_GRANT, admitted: false, publish: false, activate: false, build: false };
}

export function grantedPublicationOperations(actions: readonly string[] = ['publish', 'activate', 'build']): PublicationOperations {
  const allowed = new Set(actions);
  return {
    grant: PUBLICATION_GRANT,
    admitted: true,
    publish: allowed.has('publish'),
    activate: allowed.has('activate'),
    build: allowed.has('build'),
  };
}

export function releaseIdentity(digest: string, release: Pick<Release, 'catalogue' | 'format'>): PublicationIdentity {
  return {
    digest,
    version: typeof release.catalogue?.version === 'string' ? release.catalogue.version : null,
    format: release.format,
  };
}

export function extensionIdentity(digest: string): PublicationIdentity {
  return { digest, version: null, format: EXTENSION_DOCUMENT_FORMAT };
}

export function admittedTypes(release: Pick<Release, 'types'>, locale: string): { id: string; label: string }[] {
  return sorted(Object.keys(release.types)).flatMap((id) => {
    const labels = record(release.types[id]) && record(release.types[id].labels) ? release.types[id].labels : {};
    const label = typeof labels[locale] === 'string' ? labels[locale] : typeof labels.en === 'string' ? labels.en : id;
    return [{ id, label }];
  });
}

export function diagnosticField(diagnostic: PublicationDiagnostic): string {
  const path = diagnostic.file ? `${diagnostic.file}${diagnostic.pointer}` : diagnostic.pointer;
  return path.length > 0 ? path : '/document';
}

export function mapReleaseViolations(
  violations: readonly { pointer: string; code: string }[],
  root = '/release',
): PublicationDiagnostic[] {
  return violations.slice(0, 64).map((violation) => ({
    pointer: violation.pointer.startsWith('/') ? `${root}${violation.pointer}` : pointer(root, violation.pointer),
    code: violation.code,
    file: null,
  }));
}

export function mapExtensionViolations(
  violations: readonly { pointer: string; code: string }[],
): PublicationDiagnostic[] {
  return violations.slice(0, 64).map((violation) => ({
    pointer: violation.pointer.startsWith('/') ? `/extension${violation.pointer}` : pointer('/extension', violation.pointer),
    code: violation.code,
    file: null,
  }));
}

export const ownKeysOf = ownKeys;
