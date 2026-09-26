import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { admitNixRequest, localNixPaths, NIX_IMAGE, NIX_VERSION, parseNixClosure,
  parseNixDerivations, parseNixLock, stable, type NixOutcome, type NixRequest,
  NixResolutionUnavailable } from './nix-graph.ts';

const emptyClosure = { status: 'unobserved' as const, outputPath: null, paths: [] };
const native = 'nix --extra-experimental-features "nix-command flakes"';

async function file(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

/** One isolated native invocation. Nix evaluation and optional build are executable operations. */
export async function observeNixFlake(request: NixRequest): Promise<NixOutcome> {
  admitNixRequest(request);
  const preliminary = parseNixLock(request.flakeLock);
  const local = localNixPaths(preliminary);
  const directory = await mkdtemp(resolve('.temp/nix-run-'));
  const fixture = resolve(directory, 'fixture');
  const oracle = resolve(directory, 'oracle');
  const container = `rezics-nix-${randomUUID()}`;
  await mkdir(fixture);
  await mkdir(oracle);
  const packageRef = `path:/fixture#packages.${request.system}.${request.package}`;
  const hashCommands = local.map(({ id, path }) => {
    const lockedHash = preliminary.nodes.find(node => node.id === id)?.locked?.narHash;
    return `${native} hash path /fixture/${path} > /oracle/hash-${id}`
      + (typeof lockedHash === 'string'
        ? `; test "$(cat /oracle/hash-${id})" = '${lockedHash}' || exit 43` : '');
  }).join('; ');
  const commands = [
    `${native} --version > /oracle/version`,
    `${native} flake metadata --json path:/fixture > /oracle/metadata.json`,
    `${hashCommands}`,
    `${native} eval --raw ${packageRef}.drvPath > /oracle/selected-drv`,
    `${native} derivation show -r "$(cat /oracle/selected-drv)" > /oracle/derivations.json`,
    ...(request.runtime === 'observe' ? [
      `${native} build --no-link --print-out-paths --option sandbox false --option substitute false ${packageRef} > /oracle/output`,
      `${native} path-info --recursive --json --json-format 1 "$(cat /oracle/output)" > /oracle/closure.json`,
    ] : []),
  ].filter(Boolean);
  try {
    await writeFile(resolve(fixture, 'flake.nix'), request.flakeNix);
    await writeFile(resolve(fixture, 'flake.lock'), request.flakeLock);
    for (const source of request.files) {
      const target = resolve(fixture, source.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source.text);
    }
    const process = Bun.spawn(['docker', 'run', '--rm', '--name', container,
      '--network', 'none', '--memory', '1g', '--cpus', '1', '--pids-limit', '128',
      '--security-opt', 'no-new-privileges', '-v', `${fixture}:/fixture:ro`,
      '-v', `${oracle}:/oracle`, '-w', '/fixture', NIX_IMAGE, 'sh', '-euc',
      commands.join('; ')], { stdout: 'pipe', stderr: 'pipe' });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; process.kill(); }, 30_000);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    clearTimeout(timeout);
    if (stdout.length > 1_000_000 || stderr.length > 1_000_000) {
      throw new NixResolutionUnavailable('Nix oracle output budget exceeded');
    }
    const version = (await file(resolve(oracle, 'version')))?.trim();
    if (version !== `nix (Nix) ${NIX_VERSION}`) {
      throw new NixResolutionUnavailable('Nix oracle pin is unavailable');
    }
    const metadataText = await file(resolve(oracle, 'metadata.json'));
    let rootHash: string | null = null;
    if (metadataText) {
      const metadata = JSON.parse(metadataText) as { locked?: { narHash?: string };
        locks?: unknown };
      const lock = JSON.parse(request.flakeLock) as unknown;
      if (stable(metadata.locks) !== stable(lock)) {
        throw new NixResolutionUnavailable('native Nix changed the supplied lock');
      }
      rootHash = metadata.locked?.narHash ?? null;
    }
    const hashes: Record<string, string> = {};
    for (const item of local) {
      const hash = await file(resolve(oracle, `hash-${item.id}`));
      if (hash) hashes[item.id] = hash.trim();
    }
    const inputGraph = parseNixLock(request.flakeLock, hashes, rootHash);
    const selectedDrvPath = (await file(resolve(oracle, 'selected-drv')))?.trim();
    const derivationText = await file(resolve(oracle, 'derivations.json'));
    const derivationGraph = selectedDrvPath && derivationText
      ? parseNixDerivations(derivationText, selectedDrvPath) : null;
    let runtimeClosure: NixOutcome['runtimeClosure'] = emptyClosure;
    const outputPath = (await file(resolve(oracle, 'output')))?.trim();
    const closureText = await file(resolve(oracle, 'closure.json'));
    if (outputPath && closureText) runtimeClosure = parseNixClosure(closureText, outputPath);
    else if (outputPath) runtimeClosure = { status: 'unobserved', outputPath, paths: [] };
    const status = timedOut ? 'budget-exhausted' : !derivationGraph ? 'evaluation-failed'
      : request.runtime === 'unobserved' ? 'derivation-only'
      : runtimeClosure.status === 'observed'
      ? inputGraph.nodes.every(node => node.sourceHash !== null) ? 'observed'
        : 'source-hash-unobserved'
      : outputPath ? 'closure-unavailable' : 'build-failed';
    const failure = status === 'observed' || status === 'derivation-only'
      || status === 'source-hash-unobserved' ? null
      : timedOut ? 'timeout' : exit === 43 ? 'source-hash-mismatch'
      : stderr.includes('updating lock file') ? 'stale-lock'
      : 'native-error';
    if (exit !== 0 && status === 'observed') {
      throw new NixResolutionUnavailable('native Nix failed after closure capture');
    }
    return { status, failure, evaluator: { version: NIX_VERSION, image: NIX_IMAGE,
      system: request.system, network: 'none' }, inputGraph, derivationGraph,
    runtimeClosure, work: { inputNodes: inputGraph.nodes.length,
      inputEdges: inputGraph.edges.length, derivations: derivationGraph?.nodes.length ?? 0,
      buildEdges: derivationGraph?.edges.length ?? 0,
      closurePaths: runtimeClosure.paths.length, nativeRuns: 1 } };
  } catch (error) {
    if (error instanceof NixResolutionUnavailable) throw error;
    throw new NixResolutionUnavailable('Nix oracle could not complete');
  } finally {
    try {
      const cleanup = Bun.spawn(['docker', 'rm', '-f', container],
        { stdout: 'ignore', stderr: 'ignore' });
      await cleanup.exited;
    } catch { /* Docker was not available; temporary files are still removed. */ }
    await rm(directory, { recursive: true, force: true });
  }
}
