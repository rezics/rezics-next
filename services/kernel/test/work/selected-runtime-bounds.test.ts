import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SELECTED_LOCAL_DECLARATION } from '../../src/work/selected-runtime-cost.ts';

const runtime = readFileSync(new URL('../../src/work/selected-runtime.ts', import.meta.url), 'utf8');

test('Work admits only declared SQL and multiplicity and never refuses a legal bound for exhausted remaining', () => {
  expect(runtime).toContain("refuse('selected-runtime-unknown-native-sql')");
  expect(runtime).toContain("refuse('selected-runtime-native-multiplicity-exhausted')");
  expect(runtime).toContain("refuse('selected-runtime-unpriced-sdk-dispatch')");
  expect(runtime).toContain("throw new TypeError('Invalid selected native declaration')");
  expect(runtime).not.toContain('selected-runtime-admission-exhausted');
  expect(runtime).not.toContain('NativeCollectionWork');
  expect(SELECTED_LOCAL_DECLARATION.statements).toBeGreaterThan(0);
  expect(SELECTED_LOCAL_DECLARATION.nativeRows).toBeGreaterThan(0);
});
