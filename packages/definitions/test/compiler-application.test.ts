import { expect, test } from 'bun:test';
import { createCompilerApplication, type CompilerHost } from '../src/compiler/application.ts';
import { nativeCompiler } from '../src/adapters/compiler-host.ts';
import { bundledRelease } from '../src/bundled.ts';
import { RELEASE_FORMAT } from '../src/portable.ts';

function fakeHost(overrides: Partial<CompilerHost> = {}): CompilerHost {
  return {
    posixJoin: (...parts) => parts.join('/'),
    posixDirname: (path) => path.slice(0, Math.max(0, path.lastIndexOf('/'))),
    posixBasename: (path) => path.slice(path.lastIndexOf('/') + 1),
    posixNormalize: (path) => path,
    posixRelative: (_from, to) => to,
    yamlParse: (text) => JSON.parse(text),
    safePattern: () => true,
    filterConstruction: () => ({
      validateFilter: () => [],
      qualifiers: () => new Set(),
    }),
    parseFilter: (input) => input,
    walkFilter: function* () {},
    ...overrides,
  };
}

test('compiler application admits the bundled release through the native host', () => {
  expect(nativeCompiler().validateRelease(bundledRelease)).toEqual([]);
  expect(bundledRelease.format).toBe(RELEASE_FORMAT);
});

test('compiler application refuses an oversized collection without Filter or pattern evaluation', () => {
  let filterCalls = 0;
  let patternCalls = 0;
  const compiler = createCompilerApplication(
    fakeHost({
      filterConstruction: () => {
        filterCalls += 1;
        return { validateFilter: () => [], qualifiers: () => new Set() };
      },
      safePattern: () => {
        patternCalls += 1;
        return true;
      },
    }),
  );
  const types: Record<string, unknown> = {};
  for (let i = 0; i < 1025; i += 1) types[`ex:T${i}`] = {};
  expect(compiler.releaseAdmission({ types })).toContainEqual({ pointer: '/types', code: 'limit' });
  expect(filterCalls).toBe(0);
  expect(patternCalls).toBe(0);
});

test('nested nonempty Filter operations keep the supplied compiler after another compiler runs', () => {
  const leaked = [{ pointer: '/leaked', problem: 'nested', code: 'invalid' }] as const;
  const releaseWithFilter = structuredClone(bundledRelease);
  releaseWithFilter.filters = {
    ...releaseWithFilter.filters,
    'compiler/nested': {
      labels: { en: 'Nested filter' },
      filter: { type: { in: ['schema:Book'] } },
    },
  };
  let nested = false;
  const inner = createCompilerApplication(
    fakeHost({
      filterConstruction: () => ({
        validateFilter: () => leaked,
        qualifiers: () => new Set(['inner:qualifier']),
      }),
    }),
  );
  const outer = createCompilerApplication(
    fakeHost({
      filterConstruction: () => {
        inner.validateRelease(releaseWithFilter);
        nested = true;
        return {
          validateFilter: () => [],
          qualifiers: () => new Set(),
        };
      },
    }),
  );
  expect(outer.validateRelease(releaseWithFilter)).toEqual([]);
  expect(nested).toBe(true);
  expect(inner.validateRelease(releaseWithFilter).some((item) => item.pointer.endsWith('/leaked'))).toBe(true);
});
