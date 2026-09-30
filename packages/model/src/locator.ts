import Type, { type Static } from 'typebox';
import { Value } from 'typebox/value';
import { locatorVersion, parseLocator, type Locator } from '../../wiki-toolkit/protocol/locator.ts';

// Compatibility export: the independent Apache-2.0 protocol owns the locator contract.
export * from '../../wiki-toolkit/protocol/locator.ts';

/** Content's existing wire target. Its enclosing comment already carries revisionId/byteDigest. */
export const ContentCommentTargetSchema = Type.Object({
  type: Type.Literal('SpecificResource'),
  source: Type.String({ minLength: 1, maxLength: 2048, pattern: '^urn:rezics:content:revision:.+$' }),
  selector: Type.Object({ type: Type.Literal('TextQuoteSelector'),
    exact: Type.String({ minLength: 1 }), prefix: Type.String(), suffix: Type.String() }, { additionalProperties: false }),
}, { additionalProperties: false });
export type ContentCommentTarget = Static<typeof ContentCommentTargetSchema>;

export function locatorFromComment(comment: {
  revisionId: string; byteDigest: string; target: ContentCommentTarget;
}): Locator {
  if (!Value.Check(ContentCommentTargetSchema, comment.target)
    || comment.target.source !== `urn:rezics:content:revision:${comment.revisionId}`) {
    throw new TypeError('Comment target differs from its pinned revision');
  }
  return parseLocator({ version: locatorVersion,
    source: { type: 'hosted', revision: comment.revisionId, digest: comment.byteDigest },
    selector: comment.target.selector });
}
