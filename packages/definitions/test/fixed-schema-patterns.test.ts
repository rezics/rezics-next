import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import { validateRelease, valueSchema } from '../src/index.ts';

test('the bundled wildcard quantity boots without rewriting its fixed schema', () => {
  expect(validateRelease(bundledRelease)).toEqual([]);
  const quantity = bundledRelease.properties['wdt:P1114']!;
  expect(quantity.value).toEqual(valueSchema('quantity', { units: ['*'] }));
  const exact = structuredClone(bundledRelease);
  exact.properties['wdt:P1114']!.value = valueSchema('quantity', { units: ['*'], exact: true });
  expect(validateRelease(exact)).toEqual([]);
});

test('a modified fixed schema cannot bypass pattern safety or canonical comparison', () => {
  for (const pattern of ['^(a+)+$', '^anything$']) {
    const release = structuredClone(bundledRelease);
    const value = release.properties['wdt:P1114']!.value as {
      properties: { unit: { pattern: string } };
    };
    value.properties.unit.pattern = pattern;
    const violations = validateRelease(release);
    expect(violations).toContainEqual({ pointer: '/properties/wdt:P1114/value', code: 'invalid' });
    if (pattern === '^(a+)+$')
      expect(violations).toContainEqual({
        pointer: '/properties/wdt:P1114/value/properties/unit/pattern',
        code: 'unsafe_pattern',
      });
  }
});

test('a canonical configurable pattern still requires the safety analyzer', () => {
  const release = structuredClone(bundledRelease);
  release.properties['schema:name']!.value = valueSchema('monolingualtext', { pattern: '^(a+)+$' });
  expect(validateRelease(release)).toContainEqual({
    pointer: '/properties/schema:name/value/properties/text/pattern',
    code: 'unsafe_pattern',
  });
});
