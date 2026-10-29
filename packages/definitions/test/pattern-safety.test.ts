import { expect, test } from 'bun:test';

const safe = ['^[A-Z][a-z]+$', '^\\S', '^(?:[0-9]{8}|[0-9]{12,14})$'];
const hostile = ['^(a+)+$', '^(a|aa)+$', '^(a*)*$', '[', '\\u{110000}'];

// Each subprocess starts with cold module state. recheck's Scala.js nanoTime reads
// performance.now(), not Date.now(). No clock patch escapes the child lifetime.
async function evaluate(step: number, reverse: boolean) {
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
      for (const datatype of datatypes) results.push(['fixed', datatype, validateRelease(fixture(datatype))]);
      const patterns = ${JSON.stringify([...safe, ...hostile])};
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
    stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(stdout) as [string, string, unknown[], unknown[]?][];
}

test('pattern safety verdicts are structural and independent of clock or host load', async () => {
  for (const reverse of [false, true]) {
    const fixed = await evaluate(0, reverse);
    const advancing = await evaluate(3001, reverse);
    expect(advancing).toEqual(fixed);
    for (const [pattern, , issues] of fixed) {
      if (pattern === 'fixed' || safe.includes(pattern)) expect(issues).toEqual([]);
      else expect(issues).toHaveLength(1);
    }
  }
});

test('compiler and release validator share deterministic hostile-pattern refusal', async () => {
  for (const [pattern, datatype, issues, compiler] of await evaluate(3001, true)) {
    if (pattern === 'fixed') continue;
    if (safe.includes(pattern)) {
      expect(issues).toEqual([]);
      expect(compiler).toEqual([]);
    } else {
      expect(issues).toEqual([{
        pointer: datatype === 'string' ? '/properties/ex:p/value/pattern' : '/properties/ex:p/value/properties/text/pattern',
        code: 'unsafe_pattern',
      }]);
      expect(compiler).toEqual([{
        file: 'main.yaml', pointer: '/slots/p/pattern', code: 'unsafe_pattern',
        message: 'Pattern must be safe Unicode syntax of at most 256 characters',
      }]);
    }
  }
});
