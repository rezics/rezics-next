import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { strictContentSchema } from '../../src/content/schema-validation.ts';

test('strict Content validation preserves valid values and rejects wrong or extra fields on every call', () => {
  const shape = Type.Object({ title: Type.String() }, { additionalProperties: false });
  const schema = strictContentSchema(shape)['~standard'];
  const valid = { title: 'A public title' };
  expect(schema.jsonSchema.input()).toBe(shape);
  expect(schema.jsonSchema.output()).toBe(shape);
  for (let call = 0; call < 2; call++) {
    expect(schema.validate(valid)).toEqual({ value: valid });
    expect(schema.validate({ title: 42 })).toHaveProperty('issues');
    expect(schema.validate({ ...valid, hidden: 'private' })).toHaveProperty('issues');
  }
});

test('a custom Content validator retains its semantic refusals and the original accepted value', () => {
  const schema = strictContentSchema(Type.String(), (value) =>
    value === 'published' ? [] : [{ pointer: '', code: 'not_published' }],
  )['~standard'];
  expect(schema.validate('draft')).toHaveProperty('issues');
  expect(schema.validate('published')).toEqual({ value: 'published' });
  expect(schema.validate(null)).toHaveProperty('issues');
});
