import { expect, test } from 'bun:test';
import { contentLifecycleOf } from '../../src/semantic/adapters/ports.ts';
import { newId } from '../../src/route/route.ts';
import type { ContentQueryClient } from '../../src/semantic/contract/domain-ports.ts';

test('native cover fallback reads source-backed metadata without worker composition', async () => {
  const mediaId = newId(42000);
  const containerId = newId(42000);
  const provenance = {
    source: 'example-catalogue',
    external_id: 'record-42',
    record_revision: 'edition-3',
    digest: 'b'.repeat(64),
    converter_revision: 'converter-2',
    field_group: 'cover',
    references: [
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/42' } }] },
    ],
  };
  const credit = {
    rightsHolder: 'Image Artist',
    via: { name: 'Example Catalogue', url: 'https://catalogue.example.test/record/42' },
    license: 'LicenseRef-unknown',
    obligations: [],
  };
  let variantsJson = '[{"format":"webp","width":320}]';
  const client: ContentQueryClient = {
    async query() {
      return {
        rows: [
          {
            mediaId,
            containerId,
            sha256: 'a'.repeat(64),
            sourceUrl: 'https://images.example.test/cover.jpg',
            credit,
            provenance,
            width: 1200,
            height: 1800,
            thumbhash: 'AQID',
            color: '#5a4632',
            variantsJson,
            focalX: null,
            focalY: null,
          },
        ],
      };
    },
  };
  const lifecycle = contentLifecycleOf();
  const covers = await lifecycle.checkCovers(client, [mediaId, mediaId]);
  expect(covers.size).toBe(1);
  expect(covers.get(mediaId)).toEqual({
    id: mediaId,
    containerId,
    digest: 'a'.repeat(64),
    source: { source: provenance.source, external_id: provenance.external_id, field_group: 'cover' },
    credit,
    width: 1200,
    height: 1800,
    placeholder: { thumbhash: 'AQID', color: '#5a4632' },
    variants: [{ format: 'webp', width: 320 }],
    focalPoint: null,
  });
  variantsJson = '{';
  expect(await lifecycle.checkCover(client, mediaId)).toBeNull();
});
