import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { checkedResourceReference } from '../../../../content/src/adoption.ts';

const uuid = Type.String({ format: 'uuid' });
/** Exact owner selectors travel with an ordered use; the owner validates membership. */
export const ExactInstructionSelector = Type.Union([
  Type.Object({ grain: Type.Literal('content'), variantId: Type.String({
    pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }), revision: uuid,
  block: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, { additionalProperties: false }),
  Type.Object({ grain: Type.Literal('representation'), revision: uuid, representation: uuid,
    fragment: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }, { additionalProperties: false }),
]);
export type ExactInstructionSelector = Static<typeof ExactInstructionSelector>;

export function checkExactInstructionSelection(target: string, revision: string, selector: unknown):
  ExactInstructionSelector {
  if (!Value.Check(ExactInstructionSelector, selector) || selector.revision !== revision
    || selector.grain === 'content' && !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target)
    || selector.grain === 'representation' && !/^urn:rezics:media:asset:[0-9a-f-]{36}$/.test(target)) {
    throw new Error('instruction selection must name the exact Content or Media owner revision');
  }
  checkedResourceReference({ target, selector }, true);
  return selector;
}
