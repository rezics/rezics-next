import { expect, test } from 'bun:test';
import { kernelContract } from '../../scripts/openapi.ts';

test('the mounted Kernel publishes closed review and immediate-parent context without losing reaction fields', async () => {
  const { paths } = JSON.parse(await kernelContract());
  expect(paths['/v1/libraryShelfScorePreparation'].post.operationId).toBe('library_shelf_score.prepare');
  const page = paths['/v1/feedItems'].get.responses['200'].content['application/json'].schema;
  const personal = page.properties.viewerPersonalActions.anyOf;
  expect(personal[0].additionalProperties).toBe(false);
  expect(personal[0].properties.rows.maxItems).toBe(100);
  expect(personal[0].properties.rows.items.properties.actions.anyOf[0].properties.allowed.type).toBe('array');
  expect(personal[1].properties.reason.enum).toContain('response_limit');
  const variants = page.properties.feedItems.items.anyOf.map((schema: any) => schema.properties);
  const collection = variants.find(
    (variant: any) => variant.source.const === 'discovery' && variant.key.properties.kind.const === 'collection',
  ).summary;
  expect(collection.required).toContain('card');
  const cards = collection.properties.card.anyOf;
  expect(cards.map((card: any) => card.properties.membershipKind.const)).toEqual(['curated', 'dynamic']);
  for (const card of cards) {
    expect(card.required).toContain('curator');
    expect(card.required).toContain('preview');
    expect(card.properties.curator.anyOf[0].properties).toHaveProperty('destination');
    expect(card.properties.preview.anyOf[0].properties).toHaveProperty('partial');
  }
  const subject = variants.filter((variant: any) => variant.summary.properties.subjectReactions);
  expect(subject).toHaveLength(3);
  for (const { summary } of subject) {
    const projection = summary.properties.subjectReactions;
    const counts = projection.properties.counts.anyOf;
    expect(projection.additionalProperties).toBe(false);
    expect(projection.properties.target.properties.targetKind.const).toBe('subject');
    expect(projection.properties.target.properties.targetId.format).toBe('uuid');
    expect(counts[0].properties.state.const).toBe('available');
    expect(Object.keys(counts[0].properties.values.properties).sort()).toEqual(['insightful', 'laugh', 'like', 'love', 'sad']);
    expect(projection.properties).toHaveProperty('viewer');
  }
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
