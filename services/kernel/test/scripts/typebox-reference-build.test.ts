import { expect, test } from 'bun:test';
import { Check, Compile } from 'typebox/schema';

test('compiling repeated references visits the referenced resource independently of the number of uses', () => {
  function compileFields(count: number) {
    let walks = 0;
    const schema = {
      $id: 'https://schemas.example/fields',
      $defs: { value: { $anchor: 'value', type: 'integer' } },
      'x-observed': new Proxy(
        {},
        {
          ownKeys(target) {
            walks++;
            return Reflect.ownKeys(target);
          },
        },
      ),
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: count }, (_, i) => [`v${i}`, { $ref: '#value' }])),
    };
    const compiled = Compile(schema);
    const key = `v${count - 1}`;
    expect(compiled.Check({ [key]: 12 })).toBe(true);
    expect(compiled.Check({ [key]: '12' })).toBe(false);
    return walks;
  }

  const once = compileFields(1);
  expect(once).toBeGreaterThan(0);
  expect(compileFields(48)).toBe(once);
});

test('reference lookups use the current root, base and external context in each build', () => {
  const target = 'https://schemas.example/shared#item';
  const external = { $id: 'https://schemas.example/shared', $defs: { item: { $anchor: 'item', type: 'string' } } };
  const context = { [external.$id]: external };
  const schema = { $id: 'https://schemas.example/root', $ref: target };
  const strings = Compile(context, schema);
  expect(strings.Check('one')).toBe(true);
  expect(strings.Check(1)).toBe(false);
  external.$defs.item.type = 'integer';
  const integers = Compile(context, schema);
  expect(integers.Check(1)).toBe(true);
  expect(integers.Check('one')).toBe(false);
  expect(strings.Check('one')).toBe(true);
  expect(Check(context, schema, 1)).toBe(true);
  expect(integers.Errors('one')[0]).toBe(false);
  expect(Compile({ ...context, [target]: { type: 'boolean' } }, schema).Check(true)).toBe(true);

  const nested = (name: string, type: string) => ({
    $id: `https://schemas.example/${name}`,
    $defs: { item: { $anchor: 'item', type } },
    $ref: '#item',
  });
  const pair = Compile({ type: 'array', prefixItems: [nested('first', 'integer'), nested('second', 'string')] });
  expect(pair.Check([1, 'two'])).toBe(true);
  expect(pair.Check(['one', 2])).toBe(false);
});

test('a missed local anchor can be installed before the same schema is compiled again', () => {
  const definitions: Record<string, object> = {};
  const schema = { $id: 'https://schemas.example/local', $defs: definitions, $ref: '#item' };
  expect(Compile(schema).Check('value')).toBe(false);
  definitions.item = { $anchor: 'item', type: 'string' };
  expect(Compile(schema).Check('value')).toBe(true);
});
