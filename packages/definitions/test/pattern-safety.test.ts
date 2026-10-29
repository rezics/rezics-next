import { expect, test } from 'bun:test';

const safe = [
  '^[A-Z][a-z]+$',
  '^\\S',
  '^(?:[0-9]{8}|[0-9]{12,14})$',
  '^(?![0-9])[a-z]+$',
  '^97[89]-?(?:[0-9]-?){9}[0-9]$',
];
const hostile = [
  '^(a+)+$',
  '^(a|aa)+$',
  '^(a*)*$',
  '[',
  '\\u{110000}',
  'x'.repeat(257),
  '^a{999999999999999999999999999999}$',
  '^a{2147483647,}$',
  '^a{65}$',
  '^(?:a{8}){8}$',
  '^(?:a{64}){64}$',
  '^(?=a+)a+$',
  '^(?<=a)b$',
  '^(a)\\1$',
  '^\\p{Letter}+$',
  '('.repeat(17) + 'a' + ')'.repeat(17),
];

// Each subprocess starts with cold module state. recheck's Scala.js nanoTime reads
// performance.now(), not Date.now(). No clock patch escapes the child lifetime.
async function evaluate(step: number, reverse: boolean, inputs: string[], fixedSchemas = false) {
  const script = `
    import { validateRelease, valueSchema, DATA_TYPES, RELEASE_FORMAT } from './packages/definitions/src/index.ts';
    import { compileCatalogue, CatalogueError } from './packages/definitions/src/compile.ts';
    const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    let clock = 0;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock += ${step} });
    const fixture = (datatype, pattern) => ({
      format: RELEASE_FORMAT, catalogue: { id: 'urn:clock', version: '1' },
      generator: { name: 'test', version: '1' }, prefixes: { ex: 'https://example.org/' },
      types: { 'ex:T': { iri: 'https://example.org/T', labels: { en: 'type' }, mappings: [], bases: [], properties: ['ex:p'], facets: [] } },
      properties: { 'ex:p': { iri: 'https://example.org/p', labels: { en: 'property' }, mappings: [], datatype,
        multivalued: false, qualifiers: [], ...(datatype === 'wikibase-item' ? { targets: ['ex:T'] } : {}),
        ...(datatype === 'quantity' ? { units: ['1'] } : {}),
        value: valueSchema(datatype, { ...(datatype === 'quantity' ? { units: ['1'] } : {}), ...(pattern === undefined ? {} : { pattern }) }) } }
    });
    const results = [];
    try {
      const datatypes = ${reverse} ? [...DATA_TYPES].reverse() : DATA_TYPES;
      for (const datatype of ${fixedSchemas} ? datatypes : []) results.push(['fixed', datatype, validateRelease(fixture(datatype))]);
      const patterns = ${JSON.stringify(inputs)};
      if (${reverse}) patterns.reverse();
      for (const pattern of [...patterns, ...patterns.slice().reverse()]) {
        for (const datatype of ['string', 'monolingualtext']) {
          const issues = validateRelease(fixture(datatype, pattern));
          let compiler;
          try {
            const release = await compileCatalogue({ root: 'main.yaml', schemas: { 'main.yaml': JSON.stringify({
              id: 'urn:clock', name: 'clock', version: '1', prefixes: { ex: 'https://example.org/' },
              classes: { T: { class_uri: 'ex:T', slots: ['p'] } },
              slots: { p: { slot_uri: 'ex:p', pattern, annotations: { datatype } } }
            }) }, presentation: { en: JSON.stringify({ types: { 'ex:T': 'type' }, properties: { 'ex:p': 'property' } }) } });
            compiler = validateRelease(release);
          } catch (error) {
            if (!(error instanceof CatalogueError)) throw error;
            compiler = error.violations;
          }
          results.push([pattern, datatype, issues, compiler]);
        }
      }
    } finally {
      if (descriptor) Object.defineProperty(performance, 'now', descriptor);
      else Reflect.deleteProperty(performance, 'now');
    }
    console.log(JSON.stringify(results));
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
  return JSON.parse(stdout) as [string, string, unknown[], unknown[]?][];
}

test('pattern safety verdicts are structural and independent of clock or host load', async () => {
  for (const reverse of [false, true]) {
    const advancing = await evaluate(3001, reverse, [], true);
    for (const [, , issues] of advancing) expect(issues).toEqual([]);
    expect(advancing).toEqual(await evaluate(0, reverse, [], true));
  }
});

async function assertVerdicts(step: number, reverse: boolean, patterns: string[]) {
  const results = await evaluate(step, reverse, patterns);
  for (const [pattern, datatype, issues, compiler] of results) {
    if (safe.includes(pattern)) {
      expect(issues).toEqual([]);
      expect(compiler).toEqual([]);
    } else {
      expect(issues).toEqual([
        {
          pointer:
            datatype === 'string' ? '/properties/ex:p/value/pattern' : '/properties/ex:p/value/properties/text/pattern',
          code: 'unsafe_pattern',
        },
      ]);
      expect(compiler).toEqual([
        {
          file: 'main.yaml',
          pointer: '/slots/p/pattern',
          code: 'unsafe_pattern',
          message: 'Pattern must be safe Unicode syntax of at most 256 characters',
        },
      ]);
    }
  }
  return results;
}

test('compiler and release validator share deterministic hostile-pattern refusal', async () => {
  const patterns = [safe[0]!, hostile[0]!];
  const advancing = await assertVerdicts(3001, false, patterns);
  expect(advancing).toEqual(await assertVerdicts(0, false, patterns));
});

// Keep each cold/order comparison its own bounded unit: no test deadline changes.
for (const pattern of [...safe, ...hostile]) {
  test(`cold and repeated compiler/release verdicts: ${pattern}`, async () => {
    for (const reverse of [false, true]) {
      const advancing = await assertVerdicts(3001, reverse, [pattern]);
      expect(advancing).toEqual(await assertVerdicts(0, reverse, [pattern]));
    }
  });
}

test('structural expansion and graph limits bound short patterns with enormous analysis work', async () => {
  const { analyzePattern, safePattern, MAX_ANALYSIS_STEPS } = await import('../src/pattern-safety.ts');
  for (const pattern of hostile) expect(safePattern(pattern)).toBe(false);
  expect(safePattern('^[ab]*a[ab]{32}$')).toBe(false);
  // Reversal creates exponentially many DFA subsets *before* the native graph
  // cap applies. A real checker cancellation checkpoint exhausts the counter.
  const costly = '^[ab]{32}a[ab]*$';
  const first = analyzePattern(costly);
  expect(first.safe).toBe(false);
  expect(first.steps).toBeGreaterThanOrEqual(MAX_ANALYSIS_STEPS);
  for (const pattern of [...safe, 'a{64}', '^[{}]{2}$', '^\\u{61}+$']) {
    const result = analyzePattern(pattern);
    expect({ pattern, safe: result.safe }).toEqual({ pattern, safe: true });
    expect(result.steps).toBeGreaterThan(0);
    expect(result.steps).toBeLessThan(MAX_ANALYSIS_STEPS);
  }
  expect(analyzePattern(costly)).toEqual(first);
});
