#!/usr/bin/env bun
// The repository's landing gate, run from the root of a clean checkout: install from the lockfile, run every
// workspace's `check` script, then the control plane's own gate.
//
// With KERNEL_CHECK_REMOTE naming a readable hosts file, the whole gate runs on one development check host instead, so
// no workspace's tests compete with the machine the agents work on. GATE_REMOTE_SLOTS (default 6) is how many of that
// host's slots the run holds, while leaving one available for other checks; the output and exit code are the same as a local run's.
import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyLoadInducedOutput } from './test-lanes.ts';

const root = process.cwd();

/** The hosts file when this gate should run on a development host: named, readable and not already on one. */
function remoteHostsFile(): string | null {
  const file = process.env.KERNEL_CHECK_REMOTE;
  if (!file || process.env.KERNEL_CHECK_ON_REMOTE) return null;
  try {
    accessSync(file, constants.R_OK);
    return file;
  } catch {
    process.stderr.write(`KERNEL_CHECK_REMOTE ${file} is not readable; running the gate locally\n`);
    return null;
  }
}

function positiveInteger(name: string, value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(value)}`);
  }
  return number;
}

/** Hands the gate to a check host and returns its exit code; a signal sent here is passed on so the host cleans up. */
async function runRemoteAttempt(slots: number, concurrency: string | undefined): Promise<number> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'remote-check.ts'),
      '--gate',
      '--slots',
      String(slots),
      root,
      '--',
      ...(concurrency === undefined ? [] : ['env', `GATE_CONCURRENCY=${concurrency}`]),
      'bun',
      'scripts/gate.ts',
    ],
    { cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
  );
  const forwarders = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((name) => {
    const forward = () => child.kill(name);
    process.on(name, forward);
    return [name, forward] as const;
  });
  try {
    return await child.exited;
  } finally {
    for (const [name, forward] of forwarders) process.off(name, forward);
  }
}

/** Retries a dropped remote connection once; a signal sent here is passed on so the host cleans up. */
async function runRemotely(): Promise<number> {
  const slots = positiveInteger('GATE_REMOTE_SLOTS', process.env.GATE_REMOTE_SLOTS ?? '6');
  const concurrency = process.env.GATE_CONCURRENCY;
  const code = await runRemoteAttempt(slots, concurrency);
  if (code !== 75) return code;

  process.stderr.write('gate: remote run had a transport failure; retrying once\n');
  return await runRemoteAttempt(slots, concurrency);
}

async function run(command: string[], cwd: string): Promise<void> {
  console.log(`$ ${command.join(' ')}  (${cwd === root ? '.' : cwd.slice(root.length + 1)})`);
  const code = await Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }).exited;
  if (code !== 0) process.exit(code);
}

type Workspace = { name: string; directory: string; checkScript: string };
type WorkspaceResult = { block: string; code: number; directory: string; output: string; workspace: Workspace };

async function checkWorkspace(workspace: Workspace): Promise<WorkspaceResult> {
  const command = ['bun', 'run', 'check'];
  const startedAt = performance.now();
  const child = Bun.spawn(command, {
    cwd: workspace.directory,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const durationMs = performance.now() - startedAt;
  const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
  const relativeDirectory = workspace.directory.slice(root.length + 1);
  const block = [
    `Workspace ${workspace.name} finished in ${(durationMs / 1000).toFixed(2)}s`,
    `$ ${command.join(' ')}  (${relativeDirectory})`,
    output,
  ]
    .filter(Boolean)
    .join('\n');
  return { block: `${block}\n\n`, code, directory: relativeDirectory, output, workspace };
}

if (remoteHostsFile()) process.exit(await runRemotely());

await run(['bun', 'install', '--frozen-lockfile'], root);
const manifests = [...new Bun.Glob('{apps,services,packages}/*/package.json').scanSync({ cwd: root })].sort();
const workspaces: Workspace[] = [];
for (const manifest of manifests) {
  const { name, scripts } = (await Bun.file(join(root, manifest)).json()) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  if (!scripts?.check) throw new Error(`${manifest} has no check script`);
  workspaces.push({
    name: name ?? dirname(manifest),
    directory: join(root, dirname(manifest)),
    checkScript: scripts.check,
  });
}

const configuredConcurrency = process.env.GATE_CONCURRENCY;
const concurrency = configuredConcurrency === undefined ? workspaces.length : Number(configuredConcurrency);
if (workspaces.length > 0 && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
  throw new Error(`GATE_CONCURRENCY must be a positive integer, received ${JSON.stringify(configuredConcurrency)}`);
}

let nextWorkspace = 0;
const failures: WorkspaceResult[] = [];
const worker = async (): Promise<void> => {
  while (nextWorkspace < workspaces.length) {
    const index = nextWorkspace++;
    const result = await checkWorkspace(workspaces[index]);
    if (result.code === 0) process.stdout.write(result.block);
    else failures.push(result);
  }
};

await Promise.all(Array.from({ length: Math.min(concurrency, workspaces.length) }, () => worker()));

const failedByDirectory = new Map(failures.map((failure) => [failure.workspace.directory, failure]));
const remainingFailures: WorkspaceResult[] = [];
const loadSensitive: string[] = [];
for (const workspace of workspaces) {
  const failure = failedByDirectory.get(workspace.directory);
  if (!failure) continue;
  const usesCheckRunner = /\bscripts\/check\.ts\b/.test(workspace.checkScript);
  const loadFailures = classifyLoadInducedOutput(failure.output);
  if (usesCheckRunner || !loadFailures || loadFailures.length === 0) {
    remainingFailures.push(failure);
    continue;
  }

  const again = await checkWorkspace(workspace);
  if (again.code === 0) {
    process.stdout.write(failure.block);
    process.stdout.write(again.block);
    loadSensitive.push(`${workspace.name} (${failure.directory})`);
  } else {
    remainingFailures.push({
      ...again,
      block: `${failure.block}Workspace ${workspace.name} failed again alone:\n${again.block}`,
    });
  }
}

if (loadSensitive.length > 0) {
  process.stdout.write(
    `Load-sensitive workspaces (passed on retry): ${loadSensitive.length}\n${loadSensitive.join('\n')}\n`,
  );
}

if (remainingFailures.length > 0) {
  for (const failure of remainingFailures) process.stdout.write(failure.block);
  // Promotion bisects on the first named workspace's check instead of the whole gate.
  process.stdout.write(`Failed workspaces: ${remainingFailures.map((failure) => failure.directory).join(' ')}\n`);
  process.exitCode = 1;
} else {
  await run(['bun', 'tools/goal/scripts/gate.ts'], root);
}
