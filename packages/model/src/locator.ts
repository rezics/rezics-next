import Type, { type Static } from 'typebox';
import { Value } from 'typebox/value';
import { locatorVersion, parseLocator, type Locator } from '@rezics/wiki-toolkit/protocol';

// Compatibility export: the independent Apache-2.0 protocol owns the locator contract.
export * from '@rezics/wiki-toolkit/protocol/locator';

const commentSource = Type.String({ minLength: 1, maxLength: 2048, pattern: '^urn:rezics:content:revision:.+$' });

/** Quote target while the revision source is still available. */
export const ContentCommentQuoteTargetSchema = Type.Object({
  type: Type.Literal('SpecificResource'),
  source: commentSource,
  selector: Type.Object({ type: Type.Literal('TextQuoteSelector'),
    exact: Type.String({ minLength: 1 }), prefix: Type.String(), suffix: Type.String() }, { additionalProperties: false }),
}, { additionalProperties: false });
export type ContentCommentQuoteTarget = Static<typeof ContentCommentQuoteTargetSchema>;

/** Anchor left after source selectors are cleared. It carries no quote. */
export const ContentCommentErasedTargetSchema = Type.Object({
  type: Type.Literal('SpecificResource'),
  source: commentSource,
}, { additionalProperties: false });

/** Content's existing wire target. Its enclosing comment already carries revisionId/byteDigest. */
export const ContentCommentTargetSchema = Type.Union([
  ContentCommentQuoteTargetSchema,
  ContentCommentErasedTargetSchema,
]);
export type ContentCommentTarget = Static<typeof ContentCommentTargetSchema>;

export function locatorFromComment(comment: {
  revisionId: string; byteDigest: string; target: ContentCommentTarget;
}): Locator {
  if (!Value.Check(ContentCommentQuoteTargetSchema, comment.target)
    || comment.target.source !== `urn:rezics:content:revision:${comment.revisionId}`) {
    throw new TypeError('Comment target differs from its pinned revision');
  }
  return parseLocator({ version: locatorVersion,
    source: { type: 'hosted', revision: comment.revisionId, digest: comment.byteDigest },
    selector: comment.target.selector });
}
