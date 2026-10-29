import { expect, test } from 'bun:test';
import { Compile } from 'typebox/schema';
import schema from '../schema/release.json';
import { bundledDigest, bundledRelease, bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { releaseDigest, validateRelease, valueSchema } from '../src/index.ts';
import { analyzePattern, MAX_ANALYSIS_STEPS } from '../src/pattern-safety.ts';

const iri = schema.$defs.iri.pattern;
const wildcard = `^(?:1|${iri})$`;
const proven = [
  iri,
  wildcard,
  // Equivalent class spelling proves this is a grammar, not a byte whitelist.
  wildcard.replace('[A-Za-z]', '[a-zA-Z]').replace('[A-Za-z0-9+.-]', '[a-zA-Z0-9.+-]'),
];
const nearMisses = [
  wildcard.replace('[A-Za-z0-9+.-]*', '(?:[A-Za-z0-9+.-]+)+'),
  wildcard.replace('[A-Za-z0-9+.-]', '[A-Za-z0-9+.:~-]'),
  wildcard.replace('*$)', '+)+$)').replace('[^', '(?:[^'),
  wildcard.replace('(?![\\s\\S])', '(?!a+)'),
  wildcard + '|^(a+)+$',
  wildcard + '(a)\\1',
  `(?m:${wildcard})`,
  wildcard + '[',
  '^[ab]{32}a[ab]*$',
];

test('the static proof is bounded separately from native automaton analysis', () => {
  for (const pattern of proven)
    expect(analyzePattern(pattern)).toEqual({ safe: true, steps: 0, proof: 'iri-composition' });
  const ordinary = analyzePattern('^a+$');
  expect(ordinary.safe).toBe(true);
  expect(ordinary.proof).toBeUndefined();
  expect(ordinary.steps).toBeGreaterThan(0);
  expect(ordinary.steps).toBeLessThan(MAX_ANALYSIS_STEPS);
  // Similar but out-of-grammar classes and wrappers must use ordinary analysis.
  for (const pattern of [
    iri.replace('[A-Za-z]', '[1A-Za-z]'),
    iri.replace('[A-Za-z0-9+.-]', '[A-z]'),
    `(?:${wildcard})`,
    '('.repeat(17) + iri + ')'.repeat(17),
    iri + 'a'.repeat(256),
  ])
    expect(analyzePattern(pattern).proof).toBeUndefined();
});

// Each child patches the host clock before a cold import of the real authority.
// Compiler/release checks below are native; the checker and validation are not mocked.
for (const step of [0, 3001]) {
  for (const pattern of [...proven, ...nearMisses]) {
    test(`IRI proof and hostile composition through compiler/release (clock ${step}, ${pattern})`, async () => {
      const script = `
        let clock = 0;
        Object.defineProperty(performance, 'now', { configurable: true, value: () => clock += ${step} });
        const { analyzePattern } = await import('./packages/definitions/src/pattern-safety.ts');
        const { validateRelease, valueSchema, RELEASE_FORMAT } = await import('./packages/definitions/src/index.ts');
        const { compileCatalogue, CatalogueError } = await import('./packages/definitions/src/compile.ts');
        const pattern = ${JSON.stringify(pattern)};
        const release = {
          format: RELEASE_FORMAT, catalogue: { id: 'urn:proof', version: '1' },
          generator: { name: 'test', version: '1' }, prefixes: { ex: 'https://example.org/' },
          types: { 'ex:T': { iri: 'https://example.org/T', labels: { en: 'type' }, mappings: [],
            bases: [], properties: ['ex:p'], facets: [] } },
          properties: { 'ex:p': { iri: 'https://example.org/p', labels: { en: 'property' }, mappings: [],
            datatype: 'string', multivalued: false, qualifiers: [], value: valueSchema('string', { pattern }) } }
        };
        let compiler;
        try {
          const compiled = await compileCatalogue({
            root: 'main.yaml',
            schemas: { 'main.yaml': JSON.stringify({
              id: 'urn:proof', name: 'proof', version: '1', default_range: 'string',
              prefixes: { ex: 'https://example.org/', linkml: 'https://w3id.org/linkml/' },
              imports: ['linkml:types'],
              classes: { T: { class_uri: 'ex:T', slots: ['p'] } },
              slots: { p: { slot_uri: 'ex:p', pattern, annotations: { datatype: 'string' } } }
            }) },
            presentation: { en: JSON.stringify({ types: { 'ex:T': 'type' }, properties: { 'ex:p': 'property' } }) }
          });
          compiler = validateRelease(compiled);
        } catch (error) {
          if (!(error instanceof CatalogueError)) throw error;
          compiler = error.violations;
        }
        console.log(JSON.stringify({
          first: analyzePattern(pattern), repeated: analyzePattern(pattern),
          issues: validateRelease(release), compiler
        }));
      `;
      const child = Bun.spawn([process.execPath, '--eval', script], {
        cwd: new URL('../../../', import.meta.url).pathname,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      const result = JSON.parse(stdout);
      expect(result.repeated).toEqual(result.first);
      if (proven.includes(pattern)) {
        expect(result.first).toEqual({ safe: true, steps: 0, proof: 'iri-composition' });
        expect(result.issues).toEqual([]);
        expect(result.compiler).toEqual([]);
      } else {
        expect(result.first.safe).toBe(false);
        expect(result.first.proof).toBeUndefined();
        expect(result.first.steps).toBeLessThanOrEqual(MAX_ANALYSIS_STEPS + 1);
        if (pattern === '^[ab]{32}a[ab]*$') expect(result.first.steps).toBeGreaterThanOrEqual(MAX_ANALYSIS_STEPS);
        expect(result.issues).toEqual([{ pointer: '/properties/ex:p/value/pattern', code: 'unsafe_pattern' }]);
        expect(result.compiler).toEqual([
          {
            file: 'main.yaml',
            pointer: '/slots/p/pattern',
            code: 'unsafe_pattern',
            message: 'Pattern must be safe Unicode syntax of at most 256 characters',
          },
        ]);
      }
    });
  }
}

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
  expect(value).toMatchObject({
    properties: { unit: { type: 'string', pattern: `^(?:1|${schema.$defs.iri.pattern})$` } },
  });
  const validator = Compile(property.value);
  for (const unit of ['1', 'urn:unit', 'https://example.org/unit', 'A1+.-:量:単位', 'a:']) {
    expect({ unit, valid: validator.Check({ amount: '+1', unit }) }).toEqual({ unit, valid: true });
  }
  for (const unit of [
    '',
    'relative/unit',
    '/unit',
    ':unit',
    '1:unit',
    'a_b:unit',
    'a:bad unit',
    'a:\u0000',
    'a:\u001f',
    'a:\u007f',
    'a:\u009f',
    'a:<',
    'a:"',
    'a:{',
    'a:|',
    'a:\\',
    'a:^',
    'a:`',
    'urn:unit\n',
    'urn:unit\r\n',
    'urn:unit\u2028',
    'urn:unit\u2029',
  ]) {
    expect({ unit, valid: validator.Check({ amount: '+1', unit }) }).toEqual({ unit, valid: false });
  }
  for (const content of [{ amount: '+1' }, { amount: '+1', unit: 1 }, { amount: '1', unit: '1' }])
    expect(validator.Check(content)).toBe(false);
  // The literal branch retains its native end-of-input semantics as well.
  for (const unit of ['1\n', '1\r', '1\r\n', '1\u2028', '1\u2029'])
    expect(validator.Check({ amount: '+1', unit })).toBe(false);
});
