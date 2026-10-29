import { expect, test } from 'bun:test';
import { Compile } from 'typebox/schema';
import schema from '../schema/release.json';
import { bundledDigest, bundledRelease, bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { releaseDigest, validateRelease, valueSchema } from '../src/index.ts';

test('the whole current bundled catalogue compiles and validates without changing the released bytes', async () => {
  // Use the same recursive source loader as catalogue.test.ts, including future
  // catalogue files and patterns rather than a reduced quantity fixture.
  const compiled = await compileCatalogue(bundledSources());
  expect(validateRelease(compiled)).toEqual([]);
  expect(compiled).toEqual(bundledRelease);
  expect(releaseDigest(compiled)).toBe(bundledDigest);
});

test('the immutable bundled release validates with wildcard quantity units', () => {
  expect(validateRelease(bundledRelease)).toEqual([]);
});

test('wildcard quantity retains the released IRI composition and native unit language', () => {
  const property = bundledRelease.properties['wdt:P1114']!;
  expect(property.datatype).toBe('quantity');
  expect(property.units).toEqual(['*']);
  const value = valueSchema('quantity', { units: ['*'] });
  expect(property.value).toEqual(value);
  expect(value.properties!.unit).toEqual({ type: 'string', pattern: `^(?:1|${schema.$defs.iri.pattern})$` });
  const validator = Compile(property.value);
  for (const unit of ['1', 'urn:unit', 'https://example.org/unit', 'A1+.-:量:単位', 'a:']) {
    expect({ unit, valid: validator.Check({ amount: '+1', unit }) }).toEqual({ unit, valid: true });
  }
  for (const unit of [
    '', 'relative/unit', '/unit', ':unit', '1:unit', 'a_b:unit', 'a:bad unit',
    'a:\u0000', 'a:\u001f', 'a:\u007f', 'a:\u009f', 'a:<', 'a:"', 'a:{', 'a:|', 'a:\\', 'a:^', 'a:`',
    'urn:unit\n', 'urn:unit\r\n', 'urn:unit\u2028', 'urn:unit\u2029',
  ]) {
    expect({ unit, valid: validator.Check({ amount: '+1', unit }) }).toEqual({ unit, valid: false });
  }
  for (const content of [{ amount: '+1' }, { amount: '+1', unit: 1 }, { amount: '1', unit: '1' }])
    expect(validator.Check(content)).toBe(false);
  // Preserve the released literal branch's ECMAScript $ semantics as well.
  for (const unit of ['1\n', '1\r', '1\r\n', '1\u2028', '1\u2029'])
    expect(validator.Check({ amount: '+1', unit })).toBe(true);
});
