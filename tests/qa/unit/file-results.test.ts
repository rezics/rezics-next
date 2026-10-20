import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { parseJUnit, UNEXECUTED_FILE_TEST } from '../../../scripts/qa/acceptance.ts';
import { completeFileResults } from '../../../scripts/qa/file-results.ts';

const root = resolve(import.meta.dir, '../../..');
const file = 'tests/qa/integration/.temp/forwarded-owner.test.ts';
const suite = (path: string, body = '') =>
  `<testsuite file="${path}"><testcase name="original owner outcome" file="${path}" assertions="23">${body}</testcase></testsuite>`;

test('absolute Bun reporter paths qualify only the same selected file', () => {
  const raw = suite(join(root, file));
  const result = completeFileResults(raw, [file, 'tests/qa/integration/not-run.test.ts'], 'integration');
  expect(result.missing).toEqual(['tests/qa/integration/not-run.test.ts']);
  const cases = parseJUnit(result.xml, 'integration', { root });
  expect(cases[0]).toMatchObject({ file, failed: false, skipped: false });
  expect(cases.filter(item => item.name === UNEXECUTED_FILE_TEST).map(item => item.file))
    .toEqual(['tests/qa/integration/not-run.test.ts']);
  expect(result.xml).toContain('assertions="23"');
  expect(completeFileResults(suite(join(root, '..', 'foreign-checkout', file)), [file], 'integration').missing)
    .toEqual([file]);
});

test('absolute reporting preserves real failures and incomplete or skipped file refusal', () => {
  const failure = completeFileResults(suite(join(root, file), '<failure message="actual outcome failed" />'), [file], 'integration');
  expect(failure.missing).toEqual([]);
  expect(parseJUnit(failure.xml, 'integration', { root })[0])
    .toMatchObject({ file, failed: true, detail: 'actual outcome failed' });
  expect(completeFileResults(suite(join(root, file), '<skipped />'), [file], 'integration').missing)
    .toEqual([file]);
  expect(completeFileResults(suite(join(root, file)), [file], 'integration', {
    interrupted: true, incompleteFiles: [join(root, file)],
  }).missing).toEqual([file]);
  expect(completeFileResults(suite('./' + file), [file], 'integration').missing).toEqual([]);
});

test('explicit reporter root survives a different launcher cwd and keeps evidence fail closed', () => {
  const reporterRoot = join(root, '.temp', 'qualified-runner');
  const failed = 'tests/qa/integration/failed.test.ts';
  const skipped = 'tests/qa/integration/skipped.test.ts';
  const incomplete = 'tests/qa/integration/incomplete.test.ts';
  const missing = 'tests/qa/integration/missing.test.ts';
  const rawSuites = [suite(join(reporterRoot, file)),
    suite(join(reporterRoot, failed), '<failure message="actual owner failure" />'),
    suite(join(reporterRoot, skipped), '<skipped />'),
    suite(join(reporterRoot, incomplete))];
  const raw = rawSuites.join('');

  expect(reporterRoot).not.toBe(process.cwd());
  const result = completeFileResults(raw, [file, failed, skipped, incomplete, missing], 'integration', {
    root: reporterRoot, interrupted: true, incompleteFiles: [join(reporterRoot, incomplete)],
  });
  expect(result.missing).toEqual([skipped, incomplete, missing]);
  const cases = parseJUnit(result.xml, 'integration', { root: reporterRoot });
  expect(cases.find(item => item.file === file)).toMatchObject({ failed: false, skipped: false });
  expect(cases.find(item => item.file === failed))
    .toMatchObject({ failed: true, detail: 'actual owner failure' });
  expect(cases.find(item => item.file === skipped && item.name !== UNEXECUTED_FILE_TEST)?.skipped).toBe(true);
  expect(cases.filter(item => item.name === UNEXECUTED_FILE_TEST).map(item => item.file))
    .toEqual([skipped, incomplete, missing]);
  for (const rawSuite of rawSuites) expect(result.xml).toContain(rawSuite);
  expect(completeFileResults(suite(join(root, file)), [file], 'integration', { root: reporterRoot }).missing)
    .toEqual([file]);
});
