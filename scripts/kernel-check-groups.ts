// Run from the candidate checkout. Each child owns one remote run, its containers and its settlement.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkPlan } from '../services/kernel/scripts/check.ts';
import { currentCheckSourceManifest, type CandidateSourceManifest } from './check-source.ts';
import { performanceHosts } from './check-placement.ts';
import {
  executionCancellationFromEnvironment,
  readHosts,
  remoteCheck,
  type RemoteCheckSettlement,
} from './remote-check.ts';
import { hostsLocation } from './stack-run.ts';

export function kernelGroups(files: string[], manifest: CandidateSourceManifest) {
  const prefix = 'services/kernel/';
  const pattern = new Bun.Glob('test/**/*.test.ts');
  const expected = manifest.entries
    .filter((entry) => entry.path.startsWith(prefix) && pattern.match(entry.path.slice(prefix.length)))
    .map((entry) => entry.path.slice(prefix.length))
    .sort();
  if (!files.length || files.length !== expected.length || files.some((file, i) => file !== expected[i]))
    throw new Error('Kernel full check selection differs from the exact source inventory');
  const groups: string[][] = [];
  for (let i = 0; i < files.length; i += 32) groups.push(files.slice(i, i + 32));
  return groups;
}

export async function runKernelGroups(
  groups: string[][],
  source: string,
  host: string,
  run: (command: string[], index: number) => Promise<{ code: number; settlement?: RemoteCheckSettlement }>,
) {
  const runs = new Set<string>();
  for (const [index, files] of groups.entries()) {
    const command = [
      'env',
      'KERNEL_CHECK_CONCURRENCY=1',
      'bun',
      'scripts/check.ts',
      index === 0 ? '--full-quality' : '--tests-only',
      ...files,
    ];
    const { code, settlement } = await run(command, index);
    if (
      code !== 0 ||
      !settlement ||
      settlement.host !== host ||
      settlement.native?.host !== host ||
      settlement.native.run !== settlement.run ||
      settlement.native.exitCode !== 0 ||
      settlement.native.lifetimeFailure ||
      settlement.preparedInputs?.sourceSha256 !== source ||
      runs.has(settlement.run) ||
      settlement.cleanup.host !== host ||
      settlement.cleanup.run !== settlement.run ||
      settlement.cleanup.status !== 'verified' ||
      !settlement.transportChildReaped
    )
      throw new Error(
        `Kernel group ${index + 1}/${groups.length} lacks a passing exact-source settlement (exit ${code})`,
      );
    runs.add(settlement.run);
  }
}

if (import.meta.main) {
  const [host, ...args] = process.argv.slice(2);
  if (!host || args.length) throw new Error('Usage: bun scripts/kernel-check-groups.ts HOST');
  const root = resolve(import.meta.dir, '..');
  const location = hostsLocation(root, process.env);
  if ('reason' in location) throw new Error(location.reason);
  const hosts = performanceHosts(readHosts(location.file)).filter((entry) => entry.name === host);
  if (hosts.length !== 1 || hosts[0]!.memoryPerRunGiB !== 8)
    throw new Error('Select one configured performance host with the 8 GiB run cap');
  const manifest = await currentCheckSourceManifest(root);
  const files = checkPlan([], join(root, 'services/kernel')).tests;
  const groups = kernelGroups(files, manifest);
  const temp = join(root, '.temp');
  mkdirSync(temp, { recursive: true });
  const evidence = mkdtempSync(join(temp, 'kernel-groups-'));
  writeFileSync(
    join(evidence, 'plan.json'),
    JSON.stringify({ head: manifest.head, sourceSha256: manifest.sourceSha256, host, groups }),
  );
  console.log(`Kernel full check: ${files.length} files in ${groups.length} serial groups. Evidence: ${evidence}`);
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => controller.abort());
  const cancellation = executionCancellationFromEnvironment();
  await runKernelGroups(groups, manifest.sourceSha256, host, async (command, index) => {
    let settlement: RemoteCheckSettlement | undefined;
    const code = await remoteCheck(
      {
        workspace: root,
        cwd: 'services/kernel',
        hosts,
        allowedHosts: [host],
        slots: 1,
        memoryGiB: 8,
        maxTransportAttempts: 1,
        command,
        expectedSourceManifest: manifest,
        expectedSourceSha256: manifest.sourceSha256,
        ...(cancellation ? { cancellation } : {}),
        settled(value) {
          settlement = value;
          writeFileSync(join(evidence, `group-${index + 1}.json`), JSON.stringify({ command, settlement }));
        },
      },
      controller.signal,
    );
    return { code, ...(settlement ? { settlement } : {}) };
  });
  console.log(
    `Kernel full check passed: ${files.length} files and global quality at ${manifest.head} (${manifest.sourceSha256}).`,
  );
}
