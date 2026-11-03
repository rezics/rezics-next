import { expect, test } from 'bun:test';
import { kernelContract } from '../../scripts/openapi.ts';

test('the mounted Kernel publishes closed review and immediate-parent context without losing reaction fields', async () => {
  const { paths } = JSON.parse(await kernelContract());
  expect(paths['/v1/libraryShelfScorePreparation'].post.operationId).toBe('library_shelf_score.prepare');
  const page = paths['/v1/feedItems'].get.responses['200'].content['application/json'].schema;
  const variants = page.properties.feedItems.items.anyOf.map((schema: any) => schema.properties);
  const content = variants.filter((variant: any) => variant.summary.properties.reviewContext);
  expect(content.map((variant: any) => [variant.source.const, variant.key.properties.kind.const])).toEqual([
    ['discovery', 'review'],
    ['following', 'thread'],
    ['following', 'post'],
  ]);
  for (const { summary } of content) {
    expect(summary.additionalProperties).toBe(false);
    expect(summary.properties.reviewContext.additionalProperties).toBe(false);
    expect(Object.keys(summary.properties)).toContain('viewerReaction');
    expect(Object.keys(summary.properties)).toContain('reactions');
  }
  const review = content[0].summary.properties.reviewContext.properties;
  const citation = review.citation.anyOf[0].properties;
  expect(citation.question.properties.revision.minimum).toBe(1);
  expect(citation.units.type).toBe('integer');
  expect(citation.voteRevision.minimum).toBe(1);
  const parent = content[2].summary.properties.parentContext.anyOf[1].properties.parent.anyOf;
  expect(parent[0].properties.excerpt.maxLength).toBe(160);
  expect(parent[0].properties.revisionId.format).toBe('uuid');
  expect(parent[0].properties).toHaveProperty('author');
  expect(parent[0].properties).toHaveProperty('language');
  expect(parent[0].properties).toHaveProperty('spoiler');
  expect(Object.keys(parent[1].properties)).toEqual(['id', 'state']);
  expect(Object.keys(parent[2].properties)).toEqual(['state']);
});
