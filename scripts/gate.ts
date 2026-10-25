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

await run(['bun', 'install', '--frozen-lockfile'], root);
const manifests = [...new Bun.Glob('{apps,services,packages}/*/package.json').scanSync({ cwd: root })].sort();
for (const manifest of manifests) {
  const { scripts } = (await Bun.file(join(root, manifest)).json()) as { scripts?: Record<string, string> };
  if (!scripts?.check) throw new Error(`${manifest} has no check script`);
  await run(['bun', 'run', 'check'], join(root, dirname(manifest)));
}
await run(['bun', 'tools/goal/scripts/gate.ts'], root);
