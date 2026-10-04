import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Real command-producing files, each in a fresh Bun process on the same owner
 * databases, graph and objects as the target. No reset or isolated rerun may
 * turn an order proof into an alone proof. Opt in only for qualification. */
export const integrationOrderFiles = [
  'tests/qa/integration/shared-stack.test.ts',
  'tests/qa/integration/agent-provision.test.ts',
  'tests/qa/integration/agent-profile.test.ts',
  'tests/qa/integration/credit-creation.test.ts',
  'tests/qa/integration/catalog-descriptions.test.ts',
  'tests/qa/integration/classification-vocabulary.test.ts',
  'tests/qa/integration/collection-name.test.ts',
  'tests/qa/integration/rights-offering.test.ts',
  'tests/qa/integration/rights-use-assessment.test.ts',
  'tests/qa/integration/access-avatar.test.ts',
] as const;

export async function integrationOrderPrelude(label: string): Promise<void> {
  if (process.env.REZICS_QA_ORDER_PROBE !== '1') return;
  if (
    !process.env.REZICS_QA_RUN_ID ||
    !process.env.REZICS_QA_ARTIFACT_DIR ||
    !/^[a-z0-9-]+$/.test(label)
  )
    throw new Error('Integration order probes require the QA runner and a valid label');
  const directory = join(process.env.REZICS_QA_ARTIFACT_DIR, 'order', label);
  mkdirSync(directory, { recursive: true });
  const evidence: { file: string; exitCode: number; elapsedMs: number }[] = [];
  for (const [index, file] of integrationOrderFiles.entries()) {
    const started = performance.now();
    const child = Bun.spawn([process.execPath, 'test', file], {
      env: { ...process.env, REZICS_QA_ORDER_PROBE: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    writeFileSync(join(directory, `${index + 1}.log`), stdout + stderr);
    evidence.push({ file, exitCode, elapsedMs: performance.now() - started });
    writeFileSync(
      join(directory, 'evidence.json'),
      JSON.stringify({ project: process.env.REZICS_QA_RUN_ID, files: evidence }, null, 2) + '\n',
    );
    if (exitCode !== 0)
      throw new Error(`Order prerequisite failed: ${file}; see ${directory}/${index + 1}.log`);
  }
  console.log(
    `G1045: ${label} starts after ${evidence.length} passing files on ${process.env.REZICS_QA_RUN_ID}`,
  );
}
