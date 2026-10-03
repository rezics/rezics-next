import { parseJUnit, UNEXECUTED_FILE_TEST } from './acceptance.ts';
import { junitSuites, mergeJUnit, type Tier } from './core.ts';

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

export function lastStartedTestFile(output: string): string | undefined {
  return [...output.matchAll(/^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/gm)].at(-1)?.[1];
}

/** A missing reporter file, a partial reporter or exit zero without evidence
 * cannot qualify selected files. Filtered files may legitimately match no cases. */
export function completeFileResults(
  xml: string,
  files: readonly string[],
  tier: Tier,
  options: { filtered?: boolean; interrupted?: boolean; reason?: string; elapsedMs?: number;
    incompleteFiles?: string[] } = {},
) {
  const observed = new Set(parseJUnit(xml, tier).filter(test => !test.skipped)
    .map((test) => test.file.replace(/^\.\//, '')));
  for (const file of options.incompleteFiles ?? []) observed.delete(file.replace(/^\.\//, ''));
  const missing =
    options.filtered && !options.interrupted ? [] : files.filter((file) => !observed.has(file));
  const suites = junitSuites(xml).map((suite) => suite.xml);
  for (const file of missing) {
    const reason = escapeXml(options.reason ?? 'Selected file produced no test results');
    const path = escapeXml(file);
    suites.push(
      `<testsuite name="${path}" file="${path}" tests="1" failures="1"><testcase name="${UNEXECUTED_FILE_TEST}" file="${path}" time="0"><failure message="${reason}" /></testcase></testsuite>`,
    );
  }
  return { xml: mergeJUnit(suites, options.elapsedMs ?? 0), missing };
}
