import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import type { ContentCore } from '../../content/src/core.ts';
import { assertContentPublicationBody, ContentPublicationConflict, EmptyContentPublicationBody,
  type PublishPinnedContentInput } from '../src/modules/content-publication/publish.ts';

const input: PublishPinnedContentInput = { preparationId: randomUUID(), revisionId: randomUUID(),
  expectedDigest: 'b'.repeat(64), expectedContentEpoch: randomUUID(),
  resourceId: `https://rezics.com/id/${randomUUID()}`, variantId: `urn:rezics:variant:${randomUUID()}`,
  expectedPublicationHead: null };

function contentBody(body: Record<string, unknown>, reference: Record<string, unknown> = {}) {
  return { readExactBatch: async () => [{ status: 'available', body, reference: {
    revisionId: input.revisionId, resourceId: input.resourceId, variantId: input.variantId,
    byteDigest: input.expectedDigest, ...reference } }] } as unknown as ContentCore;
}

test('G-593: structured publication is not an empty text draft', async () => {
  for (const body of [{ content: 'A prompt', parameters: [] }, { instructions: 'A skill', files: [] },
    { items: [{ media: `urn:rezics:media:${randomUUID()}` }] }, { body: { blocks: [] } }]) {
    await expect(assertContentPublicationBody(contentBody(body), input)).resolves.toBeUndefined();
    await expect(assertContentPublicationBody(contentBody(body, { byteDigest: 'c'.repeat(64) }), input))
      .rejects.toBeInstanceOf(ContentPublicationConflict);
  }
});

test('G-593: only blank text is refused by the empty publication guard', async () => {
  for (const body of ['', ' \n\t ', '\u2003']) {
    await expect(assertContentPublicationBody(contentBody({ body }), input))
      .rejects.toBeInstanceOf(EmptyContentPublicationBody);
  }
  await expect(assertContentPublicationBody(contentBody({ body: 'Chapter one' }), input))
    .resolves.toBeUndefined();
});

test('document publication checks visible content and rejects a false text projection', async () => {
  const blank = fromPlainText(' \n');
  await expect(assertContentPublicationBody(contentBody({ body: ' \n', document: blank }), input))
    .rejects.toBeInstanceOf(EmptyContentPublicationBody);
  const document = fromPlainText('A chapter');
  await expect(assertContentPublicationBody(contentBody({ body: 'wrong', document }), input))
    .rejects.toBeInstanceOf(ContentPublicationConflict);
  const component = structuredClone(fromPlainText('', 'blocks'));
  component.doc.content!.push({ type: 'image', attrs: { id: 'image', src: 'https://example.org/image.png' } });
  await expect(assertContentPublicationBody(contentBody({ body: '\n', document: component }), input))
    .resolves.toBeUndefined();
});
