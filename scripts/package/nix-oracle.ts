import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { observeNixFlake } from '../../services/main/src/modules/package/nix-adapter.ts';
import type { NixRequest } from '../../services/main/src/modules/package/nix-graph.ts';

const fixture = resolve(process.argv[2] ?? 'tests/qa/fixtures/nix-flake');
const request: NixRequest = {
  profile: 'nix-flake-native-v1', system: 'x86_64-linux', package: 'default',
  flakeNix: await readFile(resolve(fixture, 'flake.nix'), 'utf8'),
  flakeLock: await readFile(resolve(fixture, 'flake.lock'), 'utf8'),
  files: [{ path: 'base/source.txt', text: await readFile(resolve(fixture, 'base/source.txt'), 'utf8') }],
  runtime: process.argv.includes('--derivation-only') ? 'unobserved' : 'observe',
};
const outcome = await observeNixFlake(request);
const output = resolve('.temp/package-nix-oracle/result.json');
await mkdir(resolve('.temp/package-nix-oracle'), { recursive: true });
await writeFile(output, `${JSON.stringify({ request, outcome }, null, 2)}\n`);
console.log(JSON.stringify({ status: outcome.status, inputNodes: outcome.work.inputNodes,
  derivations: outcome.work.derivations, closurePaths: outcome.work.closurePaths, output }));
