import { expect, test } from 'bun:test';
import { operationGroups, operationIsAdmitted } from '../src/kernel/exposure';

test('Signed-in Home admits its existing Continue read only through actual native personal-library and reading-progress groups rather than a fictional operation flag while preserving all unknown closed and private read boundaries', async () => {
  const home = await Bun.file(new URL('../src/routes/index.tsx', import.meta.url)).text();
  const native = await Bun.file(
    new URL('../../../services/kernel/src/library/continue-routes.ts', import.meta.url),
  ).text();
  expect(native).toContain("'x-exposure': 'gate:personal_library'");
  expect(native).toContain("group: 'reading_progress'");
  expect(operationGroups['library_continue.list']).toBe('personal_library');
  expect(operationGroups['progress_session.list']).toBe('reading_progress');
  for (const operation of ['library_label.list', 'library_entry.restore'] as const)
    expect(operationIsAdmitted(operation, ['personal_library', 'reading_progress'])).toBe(false);

  // Evaluate the actual call-site conditions without creating a provider, persona or successful page.
  const admittedExpression = home.match(/const hasContinueList\s*=\s*([\s\S]*?);/)?.[1];
  const enabledExpression = home.match(/const continueEnabled\s*=\s*([\s\S]*?);/)?.[1];
  expect(admittedExpression).toBeDefined();
  expect(enabledExpression).toBeDefined();
  const admitted = new Function('operationIsAdmitted', 'viewerGroups', `return ${admittedExpression}`);
  const enabled = new Function(
    'personalRead',
    'state',
    'exposureReady',
    'exposureFailed',
    'hasContinueList',
    `return ${enabledExpression}`,
  );
  for (const groups of [
    undefined,
    [],
    ['unrelated'],
    ['library_continue.list'],
    ['personal_library'],
    ['reading_progress'],
    ['personal_library', 'library_continue.list'],
    ['library_continue.list', 'reading_progress'],
    ['personal_library', 'reading_progress'],
  ]) {
    const bothGroups = groups?.includes('personal_library') === true && groups.includes('reading_progress');
    const hasContinueList = admitted(operationIsAdmitted, groups);
    expect(hasContinueList).toBe(bothGroups);
    for (const state of ['unknown', 'signed-out', 'signed-in']) {
      for (const ready of [false, true]) {
        for (const exposureFailed of [false, true]) {
          expect(enabled({ enabled: ready }, state, groups !== undefined, exposureFailed, hasContinueList)).toBe(
            ready && state === 'signed-in' && !exposureFailed && bothGroups,
          );
        }
      }
    }
  }
  expect(home).toMatch(/\.\.\.homeContinueQuery\([\s\S]*?enabled: continueEnabled,/);
  expect(home).toContain('useContinuePreparation(continueEnabled ? continueState : undefined,');
  expect(home).toContain('continueEnabled ? { onRetry: () => void resume.refetch() } : {}');
  expect(home).toContain('resume.isError || exposureFailed || (exposureReady && !hasContinueList)');
  expect(home).toContain('!exposureReady || resume.isFetching');
});
