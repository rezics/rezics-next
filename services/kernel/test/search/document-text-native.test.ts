import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { PageDocumentReference } from '@rezics/composition';
import type { DocumentView } from '../../src/content/document-read.ts';
import { DOCUMENT_TEXT_COST, projectDocumentText, type DocumentTextSelection } from '../../src/search/document-text.ts';
import { createPublicDocumentTextSource } from '../../src/search/document-text-native.ts';

const subject = '019a0000-0000-8000-8000-000000000001';
const reference: PageDocumentReference = {
  candidate: '019a0000-0000-8000-8000-000000000002',
  document: '019a0000-0000-8000-8000-000000000003',
  digest: 'a'.repeat(64),
  language: 'ja',
};
const selection: DocumentTextSelection = {
  subject,
  observation: 'native-position-7',
  references: [reference],
};
const document: DocumentView = {
  id: reference.document,
  subjectId: subject,
  candidateId: reference.candidate,
  revision: 3,
  digest: reference.digest,
  language: reference.language,
  origin: 'account',
  author: 'author',
  licence: 'CC-BY-4.0',
  availability: 'available',
  body: fromPlainText('静かな飛行士の物語'),
};

test('the native adapter forwards the pre-materialization byte cap and preserves exact document language', async () => {
  const limits: number[] = [];
  let currentChecks = 0;
  const source = createPublicDocumentTextSource({
    dependencies: {} as never,
    context: {} as never,
    current: async (value) => {
      currentChecks += 1;
      return value.observation === selection.observation && value.references.length === 1;
    },
    read: async (_dependencies, id, _context, maximum) => {
      limits.push(maximum!);
      return id === reference.document ? { document } : null;
    },
  });
  const projected = await projectDocumentText(selection, source);
  expect(limits).toEqual([DOCUMENT_TEXT_COST.sourceBytesPerDocument]);
  expect(currentChecks).toBe(2);
  expect(projected).toMatchObject({
    coverage: 'complete',
    documents: [{ text: '静かな飛行士の物語', language: 'ja' }],
  });
});

test('a stale native selection discards every assembled document', async () => {
  let currentChecks = 0;
  const source = createPublicDocumentTextSource({
    dependencies: {} as never,
    context: {} as never,
    current: async () => ++currentChecks < 2,
    read: async () => ({ document }),
  });
  expect(await projectDocumentText(selection, source)).toMatchObject({ coverage: 'unavailable', documents: [] });
});
