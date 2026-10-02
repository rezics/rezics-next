import { expect, test } from 'bun:test';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { imageUseReconciler } from '../features/document-editor/image-uses.ts';

const representation = '11111111-1111-4111-8111-111111111111';
const originalId = '22222222-2222-4222-8222-222222222222';
const originalUse = '33333333-3333-4333-8333-333333333333';
const copyId = '44444444-4444-4444-8444-444444444444';
const copyUse = '55555555-5555-4555-8555-555555555555';
const image = (id = originalId): DocumentNode => ({ type: 'image', attrs: { id, representationId: representation,
  mediaUseId: originalUse, src: `/api/main/v1/media/representations/${representation}/bytes?use=${originalUse}`, conceal: true } });
const document = (...content: DocumentNode[]): DocumentSnapshot => ({ version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content } });

test('copy retains exact image representation and conceal intent, but binds a new stable occurrence Use', async () => {
  const sent: unknown[] = [];
  const send = (async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json({ use: copyUse }); }) as typeof fetch;
  const original = image();
  const reconcile = imageUseReconciler(document(original), 'actor', 'parent', send);
  const result = await reconcile(document(original, image(copyId)));
  expect(sent).toEqual([{ actingSubject: 'actor', target: 'parent', representation, occurrence: copyId, conceal: true }]);
  expect(result.doc.content![0]).toBe(original);
  expect(result.doc.content![1]!.attrs).toMatchObject({ id: copyId, representationId: representation, mediaUseId: copyUse, conceal: true });
  expect(result.doc.content![1]!.attrs!.src).toContain(`use=${copyUse}`);
  await reconcile(result);
  expect(sent.length).toBe(1);
});

test('import binds source occurrences to the current parent; authored external links remain intact', async () => {
  const sent: Record<string, unknown>[] = [];
  const send = (async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json({ use: copyUse }); }) as typeof fetch;
  const reconcile = imageUseReconciler(document(image()), 'actor', 'new-parent', send);
  const external: DocumentNode = { type: 'image', attrs: { id: 'external', src: 'https://example.test/image.png', conceal: true } };
  const imported = await reconcile(document(image(), external), true);
  expect(sent[0]).toMatchObject({ target: 'new-parent', occurrence: originalId, representation });
  expect(imported.doc.content![0]!.attrs!.mediaUseId).toBe(copyUse);
  expect(imported.doc.content![1]).toBe(external);
});

test('concurrent edits deduplicate occurrence binding and failed bindings remain retryable', async () => {
  let count = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const send = (async () => { count++; await ready; return Response.json({ use: copyUse }); }) as unknown as typeof fetch;
  const reconcile = imageUseReconciler(document(image()), 'actor', 'parent', send);
  const first = reconcile(document(image(copyId)));
  const next = reconcile(document(image(copyId), { type: 'paragraph', attrs: { id: 'text' }, content: [{ type: 'text', text: 'Latest text' }] }));
  release(); await first;
  expect((await next).doc.content![1]!.content![0]!.text).toBe('Latest text');
  expect(count).toBe(1);

  let attempts = 0;
  const retry = imageUseReconciler(document(image()), 'actor', 'parent', (async () => ++attempts === 1
    ? new Response(null, { status: 503 }) : Response.json({ use: copyUse })) as unknown as typeof fetch);
  await expect(retry(document(image(copyId)))).rejects.toThrow('image-reference-not-created');
  expect((await retry(document(image(copyId)))).doc.content![0]!.attrs!.mediaUseId).toBe(copyUse);
});

test('managed representation addresses imported without attributes become durable references', async () => {
  const reconcile = imageUseReconciler(document(), 'actor', 'parent', (async () => Response.json({ use: copyUse })) as unknown as typeof fetch);
  const linked = await reconcile(document({ type: 'image', attrs: { id: copyId, src: `/v1/media/representations/${representation}/bytes`, conceal: false } }), true);
  expect(linked.doc.content![0]!.attrs).toMatchObject({ representationId: representation, mediaUseId: copyUse, id: copyId });
});
