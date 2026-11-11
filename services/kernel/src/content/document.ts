import { createHash } from 'node:crypto';
import spdxLicenseIds from 'spdx-license-ids';
import {
  documentText,
  normalizeDocument,
  parseDocument,
  serializeDocument,
  type DocumentSnapshot,
} from '@rezics/document';
import { routeOf } from '../route/route.ts';
import { MAX_DOCUMENT_BYTES } from './document-limits.ts';

export { MAX_DOCUMENT_BYTES } from './document-limits.ts';

const licenseIds = new Set(spdxLicenseIds);
const licenseReference = /^LicenseRef-[A-Za-z0-9.-]+$/;

export class InvalidDocumentError extends Error {
  constructor(message = 'Invalid content document') {
    super(message);
    this.name = 'InvalidDocumentError';
  }
}

export class DocumentTooLargeError extends Error {
  constructor() {
    super('Canonical content document exceeds 2 MiB');
    this.name = 'DocumentTooLargeError';
  }
}

/** Accept a current SPDX license identifier or a syntactically valid local LicenseRef. */
export function isSpdxLicense(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    (licenseIds.has(value) || licenseReference.test(value))
  );
}

/** Accept UUIDs that carry a routable REZICS route; existence is intentionally not checked. */
export function isRoutableSubjectId(value: unknown): value is string {
  return typeof value === 'string' && routeOf(value) !== null;
}

export interface ValidatedContentDocument {
  snapshot: DocumentSnapshot;
  canonicalBytes: Uint8Array;
  sha256: string;
  searchText: string;
  licence: string;
  subjectIds: string[];
}

/** Validate untrusted content metadata and prepare its immutable storage projections. */
export function validateContentDocument(input: unknown): ValidatedContentDocument {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InvalidDocumentError();

  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['body', 'licence', 'subjectIds'].includes(key)) ||
    !Object.hasOwn(value, 'body') ||
    !Object.hasOwn(value, 'licence') ||
    !Object.hasOwn(value, 'subjectIds')
  )
    throw new InvalidDocumentError();

  if (!isSpdxLicense(value.licence)) throw new InvalidDocumentError('Invalid SPDX licence identifier');
  if (
    !Array.isArray(value.subjectIds) ||
    !value.subjectIds.every(isRoutableSubjectId) ||
    new Set(value.subjectIds).size !== value.subjectIds.length
  )
    throw new InvalidDocumentError('Invalid subject references');

  let snapshot: DocumentSnapshot;
  try {
    snapshot = normalizeDocument(parseDocument(value.body));
  } catch {
    throw new InvalidDocumentError('Invalid document snapshot');
  }

  const canonical = serializeDocument(snapshot);
  const canonicalBytes = new TextEncoder().encode(canonical);
  if (canonicalBytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentTooLargeError();

  return {
    snapshot,
    canonicalBytes,
    sha256: createHash('sha256').update(canonicalBytes).digest('hex'),
    searchText: documentText(snapshot),
    licence: value.licence,
    subjectIds: [...value.subjectIds],
  };
}
