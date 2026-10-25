import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { documentText, fromPlainText, normalizeDocument, type DocumentSnapshot } from '@rezics/document';
import {
  DocumentTooLargeError,
  InvalidDocumentError,
  isRoutableSubjectId,
  isSpdxLicense,
  validateContentDocument,
} from '../../src/content/document.ts';

const subject = '019f0000-0000-7000-8000-000000000001';

function value(body: unknown = fromPlainText('漢字 😀\n keep spaces ')) {
  return { body, licence: 'CC-BY-4.0', subjectIds: [subject] };
}

test('validates a document and returns RFC 8785 bytes, native SHA-256 and source search text', () => {
  const body = fromPlainText('漢字 😀\n keep spaces ');
  const prepared = validateContentDocument(value(body));
  const expected = canonicalize(normalizeDocument(body))!;

  expect(prepared.snapshot).toEqual(body);
  expect(prepared.canonicalBytes).toEqual(new TextEncoder().encode(expected));
  expect(prepared.sha256).toBe(new Bun.CryptoHasher('sha256').update(expected).digest('hex'));
  expect(prepared.searchText).toBe(documentText(body));
  expect(prepared.licence).toBe('CC-BY-4.0');
  expect(prepared.subjectIds).toEqual([subject]);
});

test('reordered JSON keys produce identical canonical bytes and digest', () => {
  const body = fromPlainText('same');
  const reordered = JSON.parse(JSON.stringify(body, (_key, item) => item));
  const first = validateContentDocument(value(body));
  const second = validateContentDocument({ subjectIds: [subject], licence: 'CC-BY-4.0', body: reordered });

  expect(second.canonicalBytes).toEqual(first.canonicalBytes);
  expect(second.sha256).toBe(first.sha256);
});

test('rejects invalid snapshots, licence identifiers, references and oversized canonical bytes', () => {
  expect(() => validateContentDocument(value({ version: 'wrong' }))).toThrow(InvalidDocumentError);
  expect(() => validateContentDocument({ ...value(), licence: 'MIT AND Apache-2.0' })).toThrow(InvalidDocumentError);
  expect(() => validateContentDocument({ ...value(), subjectIds: ['not-a-subject-id'] })).toThrow(InvalidDocumentError);
  expect(() => validateContentDocument(value(fromPlainText('x'.repeat(2 * 1024 * 1024))))).toThrow(
    DocumentTooLargeError,
  );
});

test('validates SPDX identifiers and well-formed LicenseRef identifiers', () => {
  expect(isSpdxLicense('MIT')).toBe(true);
  expect(isSpdxLicense('CC-BY-4.0')).toBe(true);
  expect(isSpdxLicense('LicenseRef-Author-Permission')).toBe(true);
  expect(isSpdxLicense('not-an-SPDX-licence')).toBe(false);
  expect(isSpdxLicense('LicenseRef-')).toBe(false);
});

test('validates routable subject UUIDs without looking up semantic records', () => {
  expect(isRoutableSubjectId(subject)).toBe(true);
  expect(isRoutableSubjectId('019f0000-0000-7000-8000-000000000001'.toUpperCase())).toBe(false);
  expect(isRoutableSubjectId('not-a-subject-id')).toBe(false);
});

test('preserves explicit empty reference arrays', () => {
  const prepared = validateContentDocument({ ...value(), subjectIds: [] });
  expect(prepared.subjectIds).toEqual([]);
});

const _documentTypeCheck: DocumentSnapshot | undefined = undefined;
void _documentTypeCheck;
