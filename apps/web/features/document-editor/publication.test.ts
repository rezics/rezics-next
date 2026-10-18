import { expect, test } from 'bun:test';
import { fromPlainText, normalizeDocument, parseDocument, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import { documentPublication } from './publication.ts';
import { imageUseReconciler } from './image-uses.ts';

const representation = '11111111-1111-4111-8111-111111111111';
const occurrence = '22222222-2222-4222-8222-222222222222';
const use = '33333333-3333-4333-8333-333333333333';
const text = fromPlainText('Keep the complete document', 'blocks');
const illustrated: DocumentSnapshot = normalizeDocument({ ...text, doc: { ...text.doc, content: [...text.doc.content!, {
  type: 'image', attrs: { id: occurrence, representationId: representation, mediaUseId: use,
    src: `/api/main/v1/media/representations/${representation}/bytes?use=${use}` },
}] } });

test('a failed image binding retains the current complete snapshot for retry and export', async () => {
  const persisted: string[] = [], states: string[] = [];
  let recovery = '';
  let unavailable = true;
  const publication = documentPublication(async next => {
    if (unavailable) throw new Error('Binding unavailable');
    return next;
  }, value => { persisted.push(value); }, (state, _error, retained) => {
    states.push(state);
    if (retained) recovery = JSON.stringify(retained);
  });
  await publication.publish(illustrated);
  expect(states.at(-1)).toBe('failed');
  expect(persisted).toHaveLength(0);
  expect(publication.current()).toBe(illustrated);
  expect(parseDocument(JSON.parse(recovery))).toEqual(illustrated);
  expect(parseDocument(JSON.parse(serializeDocument(publication.current()!)))).toEqual(parseDocument(illustrated));
  unavailable = false;
  await publication.retry();
  expect(states.at(-1)).toBe('ready');
  expect(parseDocument(JSON.parse(persisted[0]!))).toEqual(parseDocument(illustrated));
});

test('an older async binding cannot overwrite or mark a newer complete document saved', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const persisted: string[] = [], states: string[] = [];
  const publication = documentPublication(async next => { if (next === text) await ready; return next; },
    value => { persisted.push(value); }, state => { states.push(state); });
  const first = publication.publish(text);
  await publication.publish(illustrated);
  release(); await first;
  expect(persisted).toEqual([serializeDocument(illustrated)]);
  expect(states.at(-1)).toBe('ready');
});

test('a device persistence failure does not report the complete document saved', async () => {
  const states: string[] = [];
  const publication = documentPublication(async next => next, () => { throw new Error('Quota exceeded'); },
    state => { states.push(state); });
  await publication.publish(illustrated);
  expect(states.at(-1)).toBe('failed');
  expect(publication.current()).toBe(illustrated);
});

test('failure to retain a pending edit is reported without saving an older document', async () => {
  const states: string[] = [], persisted: string[] = [];
  const publication = documentPublication(async next => next, value => { persisted.push(value); }, state => {
    states.push(state);
    if (state === 'pending') throw new Error('Recovery storage unavailable');
  });
  expect(await publication.publish(illustrated)).toBe(false);
  expect(states.at(-1)).toBe('failed');
  expect(persisted).toHaveLength(0);
  expect(publication.current()).toBe(illustrated);
});

test('a failed editor snapshot invalidates an in-flight save of the previous document', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const persisted: string[] = [], states: string[] = [];
  const publication = documentPublication(async next => { await ready; return next; },
    value => { persisted.push(value); }, state => { states.push(state); });
  const earlier = publication.publish(text);
  publication.cancel();
  release();
  expect(await earlier).toBe(false);
  expect(persisted).toHaveLength(0);
  expect(states).not.toContain('ready');
});

test('an uploaded stable occurrence saves without another binding or any preview metadata', async () => {
  const reconcile = imageUseReconciler(text, 'author', 'work', (async () => {
    throw new Error('Preview and metadata unavailable');
  }) as unknown as typeof fetch);
  reconcile.rememberUpload(occurrence, { representationId: representation, mediaUseId: use });
  const persisted: string[] = [];
  const publication = documentPublication(reconcile, value => { persisted.push(value); }, () => {});
  await publication.publish(illustrated);
  const reopened = parseDocument(JSON.parse(persisted[0]!));
  expect(reopened.doc.content![1]!.attrs).toMatchObject({ representationId: representation, mediaUseId: use });
  expect(reopened.doc.content![0]).toEqual(text.doc.content![0]);
});
