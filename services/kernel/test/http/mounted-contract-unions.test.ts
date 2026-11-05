import { expect, expectTypeOf, test } from 'bun:test';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { appellantIdentitySchema, targetContextSchema } from '../../src/content/appeal-routes.ts';
import { copyConditionValueSchema, copyListContextSchema } from '../../src/library/personal-routes.ts';
import { COPY_CONDITION_CHOICES, type CopyConditionValue } from '../../src/library/copy-condition.ts';
import { QueryShareSchema } from '../../src/search/http/query-share-schemas.ts';

test('appeal identity and context preserve unavailable states in declarations and wire schemas', () => {
  expectTypeOf<Static<typeof appellantIdentitySchema>['state']>()
    .toEqualTypeOf<'available' | 'deleted' | 'concealed' | 'unavailable'>();
  expectTypeOf<Static<typeof targetContextSchema>['state']>()
    .toEqualTypeOf<'available' | 'concealed' | 'unavailable'>();
  for (const state of ['deleted', 'concealed', 'unavailable'])
    expect(Value.Check(appellantIdentitySchema, { state })).toBe(true);
  for (const state of ['concealed', 'unavailable'])
    expect(Value.Check(targetContextSchema, { state })).toBe(true);
});

test('Copy physical conditions and withheld contexts retain their native vocabulary', () => {
  expectTypeOf<Static<typeof copyConditionValueSchema>>().toEqualTypeOf<CopyConditionValue>();
  expectTypeOf<Static<typeof copyListContextSchema>['state']>()
    .toEqualTypeOf<'available' | 'unsupported' | 'scope' | 'withheld' | 'missing' | 'unavailable'>();
  for (const { id } of COPY_CONDITION_CHOICES) expect(Value.Check(copyConditionValueSchema, id)).toBe(true);
  expect(Value.Check(copyConditionValueSchema, 'seller_grade')).toBe(false);
  for (const state of ['scope', 'withheld', 'missing', 'unavailable'])
    expect(Value.Check(copyListContextSchema, { state })).toBe(true);
});

test('Search share reasons are a closed declared union', () => {
  const reasons = ['ready', 'private_context', 'unsupported', 'oversized', 'unavailable'] as const;
  expectTypeOf<Static<typeof QueryShareSchema>['reason']>().toEqualTypeOf<(typeof reasons)[number]>();
  for (const reason of reasons) expect(Value.Check(QueryShareSchema.properties.reason, reason)).toBe(true);
  expect(Value.Check(QueryShareSchema.properties.reason, 'exception text')).toBe(false);
});
