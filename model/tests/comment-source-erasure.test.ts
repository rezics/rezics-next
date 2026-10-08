import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { ContentCommentErasedTargetSchema, ContentCommentQuoteTargetSchema,
  ContentCommentTargetSchema, locatorFromComment } from '../../packages/model/src/locator.ts';

const revisionId = '00000000-0000-4000-8000-000000000008';
const quote = 'QUOTE-CANARY-ζ-source';
const source = `urn:rezics:content:revision:${revisionId}`;
const digest = 'ab'.repeat(32);

test('an erased comment anchor keeps the revision source and drops the quote selector', () => {
  const erased = { type: 'SpecificResource' as const, source };
  const quoted = { type: 'SpecificResource' as const, source,
    selector: { type: 'TextQuoteSelector' as const, exact: quote, prefix: 'Opening\n', suffix: '\nClosing' } };
  expect(Value.Check(ContentCommentErasedTargetSchema, erased)).toBe(true);
  expect(Value.Check(ContentCommentQuoteTargetSchema, quoted)).toBe(true);
  expect(Value.Check(ContentCommentTargetSchema, erased)).toBe(true);
  expect(Value.Check(ContentCommentTargetSchema, quoted)).toBe(true);
  expect(Value.Check(ContentCommentErasedTargetSchema, quoted)).toBe(false);
  expect(Value.Check(ContentCommentQuoteTargetSchema, erased)).toBe(false);
  expect(JSON.stringify(erased)).not.toContain(quote);
  expect(() => locatorFromComment({ revisionId, byteDigest: digest, target: erased }))
    .toThrow(TypeError);
  expect(locatorFromComment({ revisionId, byteDigest: digest, target: quoted }).selector)
    .toEqual(quoted.selector);
});
