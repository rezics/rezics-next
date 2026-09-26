import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { observeNixFlake } from '../../../services/main/src/modules/package/nix-adapter.ts';
import { admitNixRequest, NIX_IMAGE, parseNixLock, type NixRequest }
  from '../../../services/main/src/modules/package/nix-graph.ts';

const fixture = resolve('tests/qa/fixtures/nix-flake');
async function request(runtime: NixRequest['runtime'] = 'observe'): Promise<NixRequest> {
  return { profile: 'nix-flake-native-v1', system: 'x86_64-linux', package: 'default',
    flakeNix: await readFile(resolve(fixture, 'flake.nix'), 'utf8'),
    flakeLock: await readFile(resolve(fixture, 'flake.lock'), 'utf8'),
    files: [{ path: 'base/source.txt',
      text: await readFile(resolve(fixture, 'base/source.txt'), 'utf8') }], runtime };
}

test('PKG06: pinned native Nix keeps follows, build inputs and observed runtime closure distinct',
  async () => {
    const outcome = await observeNixFlake(await request());
    expect(outcome.status).toBe('observed');
    expect(outcome.evaluator).toMatchObject({ version: '2.35.2', image: NIX_IMAGE,
      system: 'x86_64-linux', network: 'none' });
    expect(outcome.inputGraph.edges).toEqual([
      { from: 'root', name: 'alias', to: ['base'] },
      { from: 'root', name: 'base', to: 'base' },
    ]);
    expect(outcome.inputGraph.nodes.every(node => node.sourceHash?.startsWith('sha256-'))).toBe(true);
    expect(outcome.derivationGraph?.nodes).toHaveLength(2);
    expect(outcome.derivationGraph?.edges).toHaveLength(1);
    expect(outcome.derivationGraph?.edges[0]?.to).toContain('rezics-nix-build-input.drv');
    expect(outcome.runtimeClosure.paths).toHaveLength(1);
    expect(outcome.runtimeClosure.paths[0]?.path).toContain('rezics-nix-result');
    expect(outcome.runtimeClosure.paths[0]?.path).not.toContain('build-input');
    expect(outcome.work).toMatchObject({ inputNodes: 2, inputEdges: 2,
      derivations: 2, buildEdges: 1, closurePaths: 1, nativeRuns: 1 });
  }, 60_000);

test('PKG06: evaluation-only leaves runtime closure explicitly unobserved', async () => {
  const outcome = await observeNixFlake(await request('unobserved'));
  expect(outcome.status).toBe('derivation-only');
  expect(outcome.derivationGraph?.edges).toHaveLength(1);
  expect(outcome.runtimeClosure).toEqual({ status: 'unobserved', outputPath: null, paths: [] });
}, 60_000);

test('PKG06: stale lock and failed build preserve partial graph without inventing a closure', async () => {
  const base = await request();
  const stale = await observeNixFlake({ ...base,
    flakeNix: base.flakeNix.replace('path:./base', 'path:./other'),
    files: [...base.files, { path: 'other/source.txt', text: 'other\n' }] });
  expect(stale.status).toBe('evaluation-failed');
  expect(stale.failure).toBe('stale-lock');
  expect(stale.inputGraph.edges).toHaveLength(2);
  expect(stale.runtimeClosure.status).toBe('unobserved');
  const failed = await observeNixFlake({ ...base,
    flakeNix: base.flakeNix.replace("printf 'runtime result\\\\n' > $out", 'exit 7') });
  expect(failed.status).toBe('build-failed');
  expect(failed.failure).toBe('native-error');
  expect(failed.derivationGraph?.nodes).toHaveLength(2);
  expect(failed.runtimeClosure.status).toBe('unobserved');
}, 90_000);

test('PKG06: cyclic input topology and follows paths stay input edges, within linear budgets', () => {
  for (const count of [4, 16, 32]) {
    const nodes: Record<string, unknown> = { root: { inputs: { entry: 'n0' } } };
    for (let index = 0; index < count - 1; index++) {
      nodes[`n${index}`] = { inputs: { next: `n${(index + 1) % (count - 1)}` } };
    }
    const graph = parseNixLock(JSON.stringify({ version: 7, root: 'root', nodes }));
    expect(graph.nodes).toHaveLength(count);
    expect(graph.edges).toHaveLength(count);
  }
  const nodes: Record<string, unknown> = { root: { inputs: { entry: 'n0' } } };
  for (let index = 0; index < 32; index++) nodes[`n${index}`] = {};
  expect(() => parseNixLock(JSON.stringify({ version: 7, root: 'root', nodes }))).toThrow();
});

test('PKG06: original branch, locked revision and exact source hash remain separate', () => {
  const sourceHash = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const graph = parseNixLock(JSON.stringify({ version: 7, root: 'root', nodes: {
    root: { inputs: { upstream: 'upstream', alias: ['upstream'] } },
    upstream: { original: { type: 'github', owner: 'example', repo: 'source', ref: 'main' },
      locked: { type: 'github', owner: 'example', repo: 'source',
        rev: '0123456789abcdef0123456789abcdef01234567', narHash: sourceHash } },
  } }));
  expect(graph.nodes.find(node => node.id === 'upstream')).toEqual({ id: 'upstream',
    original: { type: 'github', owner: 'example', repo: 'source', ref: 'main' },
    locked: { type: 'github', owner: 'example', repo: 'source',
      rev: '0123456789abcdef0123456789abcdef01234567', narHash: sourceHash },
    sourceHash });
  expect(graph.edges).toEqual([
    { from: 'root', name: 'alias', to: ['upstream'] },
    { from: 'root', name: 'upstream', to: 'upstream' },
  ]);
});

test('PKG06: source traversal, duplicate files and malformed hashes are rejected before execution',
  async () => {
    const base = await request();
    expect(() => admitNixRequest({ ...base, files: [
      { path: '../escape', text: 'bad' }] })).toThrow();
    expect(() => admitNixRequest({ ...base, files: [
      base.files[0]!, base.files[0]! ] })).toThrow();
    const lock = JSON.parse(base.flakeLock) as { nodes: { base: { locked: Record<string, unknown> } } };
    lock.nodes.base.locked.narHash = 'not-a-hash';
    expect(() => parseNixLock(JSON.stringify(lock))).toThrow();
  });
