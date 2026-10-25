#!/usr/bin/env bun
// The repository's landing gate, run from the root of a clean checkout: install from the lockfile, run every
// workspace's `check` script, then the control plane's own gate.
import { dirname, join } from 'node:path';

const root = process.cwd();

async function run(command: string[], cwd: string): Promise<void> {
  console.log(`$ ${command.join(' ')}  (${cwd === root ? '.' : cwd.slice(root.length + 1)})`);
  const code = await Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }).exited;
  if (code !== 0) process.exit(code);
}

type Workspace = { name: string; directory: string };
type WorkspaceResult = { block: string; code: number };

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
  ].filter(Boolean).join('\n');
  return { block: `${block}\n\n`, code };
}

await run(['bun', 'install', '--frozen-lockfile'], root);
const manifests = [...new Bun.Glob('{apps,services,packages}/*/package.json').scanSync({ cwd: root })].sort();
const workspaces: Workspace[] = [];
for (const manifest of manifests) {
  const { name, scripts } = (await Bun.file(join(root, manifest)).json()) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  if (!scripts?.check) throw new Error(`${manifest} has no check script`);
  workspaces.push({ name: name ?? dirname(manifest), directory: join(root, dirname(manifest)) });
}

const configuredConcurrency = process.env.GATE_CONCURRENCY;
const concurrency = configuredConcurrency === undefined ? workspaces.length : Number(configuredConcurrency);
if (workspaces.length > 0 && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
  throw new Error(`GATE_CONCURRENCY must be a positive integer, received ${JSON.stringify(configuredConcurrency)}`);
}

let nextWorkspace = 0;
const failures: string[] = [];
const worker = async (): Promise<void> => {
  while (nextWorkspace < workspaces.length) {
    const index = nextWorkspace++;
    const result = await checkWorkspace(workspaces[index]);
    if (result.code === 0) process.stdout.write(result.block);
    else failures.push(result.block);
  }
};

await Promise.all(Array.from({ length: Math.min(concurrency, workspaces.length) }, () => worker()));

if (failures.length > 0) {
  for (const block of failures) process.stdout.write(block);
  process.exitCode = 1;
} else {
  await run(['bun', 'tools/goal/scripts/gate.ts'], root);
}
