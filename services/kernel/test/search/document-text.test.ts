import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { DocumentView } from '../../src/content/document-read.ts';
import {
  DOCUMENT_TEXT_COST, projectDocumentText, selectDocumentText, verifyDocumentTextWindow,
  type PublicDocumentTextSource,
} from '../../src/search/document-text.ts';

const subject = '018f0000-0000-7000-8000-007000000001';
const reference = { candidate: '018f0000-0000-7000-8000-007000000002',
  document: '018f0000-0000-7000-8000-007000000003', digest: 'a'.repeat(64), language: 'ja' };
const selection = { subject, observation: 'native-observation-1', references: [reference] };
const value = (text = '弱火で静かに煮込む。'): DocumentView => ({ id: reference.document, subjectId: subject,
  candidateId: reference.candidate, revision: 1, language: reference.language, digest: reference.digest,
  origin: 'account', author: subject, licence: 'CC0-1.0', availability: 'available', body: fromPlainText(text) });
function owner(document = value()) {
  const requests: unknown[] = [];
  const source: PublicDocumentTextSource = { current: async () => true, read: async input => {
    requests.push(input); return { status: 'public', document };
  } };
  return { source, requests };
}

test('recipe instructions use the presentation selector and retain exact Japanese source at disclosure', async () => {
  const selected = selectDocumentText(subject, selection.observation, { statements: {
    'schema:recipeInstructions': [{ id: reference.candidate, rank: 'normal',
      property: { id: 'schema:recipeInstructions', data_type: 'document' },
      value: { type: 'value', content: reference } }],
  } }, ['schema:recipeInstructions'], 'en');
  expect(selected.references).toEqual([reference]);
  const { source, requests } = owner();
  const projection = await projectDocumentText(selected, source);
  expect(projection.coverage).toBe('complete');
  const candidate = projection.documents[0]!;
  const excerpt = await verifyDocumentTextWindow(projection, candidate,
    { start: 0, end: candidate.text.length, text: candidate.text }, source);
  expect(excerpt).toMatchObject({ status: 'available', language: 'ja', text: '弱火で静かに煮込む。',
    destination: { kind: 'subject-document', subject, document: reference.document },
    source: { candidate: reference.candidate, digest: reference.digest, revision: 1 } });
  expect(excerpt).not.toHaveProperty('body');
  expect(excerpt).not.toHaveProperty('fragment');
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({ maxSourceBytes: DOCUMENT_TEXT_COST.sourceBytesPerDocument });
});

test('missing producer, unsupported blocks and dependency failure are not complete empty results', async () => {
  expect((await projectDocumentText(selection)).coverage).toBe('unavailable');
  const document = value();
  document.body!.profile = 'blocks';
  expect((await projectDocumentText(selection, owner(document).source)).coverage).toBe('unsupported');
  const { source } = owner();
  source.read = async () => { throw new Error('producer unavailable'); };
  expect(await projectDocumentText(selection, source)).toMatchObject({ coverage: 'unavailable', documents: [] });
});

test('finite dispatch and UTF-8 prefix coverage preserve independent bodies and languages', async () => {
  const { source, requests } = owner(value('猫'.repeat(30_000)));
  const projection = await projectDocumentText({ ...selection, references: [reference, { ...reference, language: 'en' }] }, source);
  expect(projection.coverage).toBe('partial');
  expect(Buffer.byteLength(projection.documents[0]!.text)).toBeLessThanOrEqual(DOCUMENT_TEXT_COST.textBytesPerSubject);
  expect(projection.documents[0]!.text).not.toContain('�');
  expect(projection.documents).toHaveLength(1);
  expect(requests.length).toBeLessThanOrEqual(2);
  await expect(projectDocumentText({ ...selection, references: Array(9).fill(reference) }, source)).rejects.toThrow(RangeError);
  expect(requests.length).toBeLessThanOrEqual(2);
});

test('rights withdrawal, reference replacement and concealment cannot retain a public excerpt', async () => {
  const { source } = owner();
  const projection = await projectDocumentText(selection, source), candidate = projection.documents[0]!;
  const window = { start: 0, end: candidate.text.length, text: candidate.text };
  source.read = async () => ({ status: 'absent' });
  expect(await verifyDocumentTextWindow(projection, candidate, window, source)).toEqual({ status: 'restart' });
  source.read = async () => ({ status: 'public', document: { ...value(), candidateId: crypto.randomUUID() } });
  expect((await verifyDocumentTextWindow(projection, candidate, window, source)).status).toBe('unavailable');
  source.read = async () => ({ status: 'public', document: value() });
  let fences = 0;
  source.current = async () => ++fences === 1;
  expect(await verifyDocumentTextWindow(projection, candidate, window, source)).toEqual({ status: 'restart' });
});

test('edited text, forged windows, oversized excerpts and split Unicode are refused', async () => {
  const { source } = owner(value('x😀y'));
  const projection = await projectDocumentText(selection, source), candidate = projection.documents[0]!;
  for (const window of [{ start: 0, end: 1, text: '<b>x</b>' }, { start: 1, end: 2, text: '\ud83d' }])
    expect((await verifyDocumentTextWindow(projection, candidate, window, source)).status).toBe('unavailable');
  source.read = async () => ({ status: 'public', document: value('changed') });
  expect((await verifyDocumentTextWindow(projection, candidate, { start: 0, end: 1, text: 'x' }, source)).status).toBe('restart');
  const large = owner(value('x'.repeat(300))), projected = await projectDocumentText(selection, large.source);
  expect((await verifyDocumentTextWindow(projected, projected.documents[0]!,
    { start: 0, end: 300, text: 'x'.repeat(300) }, large.source)).status).toBe('unavailable');
});
