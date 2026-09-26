import { mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { npmFixture, npmNativeCases } from '../../tests/qa/fixtures/npm-lock-snapshot.ts';
import { npmSha, npmStable, validateNpmSnapshot } from '../../services/main/src/modules/package/npm-lock.ts';
import { npmPlatformCases, npmPlatformFixture, npmTargets } from '../../tests/qa/fixtures/npm-platform-snapshot.ts';
import { validateNpmPlatformSnapshot } from '../../services/main/src/modules/package/npm-platform.ts';
import { compareNpmPlatform } from './npm-platform-compare.ts';
import { npmIdentityCases, npmIdentityFixture } from '../../tests/qa/fixtures/npm-identity-snapshot.ts';
import { validateNpmIdentitySnapshot, type NpmIdentityOutcome } from '../../services/main/src/modules/package/npm-identity.ts';
import { NpmResolutionInvalid } from '../../services/main/src/modules/package/npm-lock.ts';
import { compareNpmIdentity } from './npm-identity-compare.ts';
import { npmCompositionCases, npmCompositionFixture, npmCompositionTargets } from '../../tests/qa/fixtures/npm-composition-snapshot.ts';
import { validateNpmCompositionSnapshot, type NpmCompositionOutcome } from '../../services/main/src/modules/package/npm-composition.ts';
import { compareNpmComposition } from './npm-composition-compare.ts';

const base = resolve(import.meta.dir, '../../.temp/package-npm-oracle');
await mkdir(base, { recursive: true });
const binary = Bun.which('npm');
if (!binary) throw new Error('npm 11.19.1 must be installed with the pinned Node');
const cli = await realpath(binary);
const npmPackage = resolve(dirname(cli), '../package.json');
if (JSON.parse(await readFile(npmPackage, 'utf8')).version !== '11.19.1') {
  throw new Error('npm package version differs from 11.19.1');
}
const home = resolve(base, 'home');
await mkdir(home, { recursive: true });
const config = resolve(base, 'npmrc');
await writeFile(config, '');
const env = { PATH: Bun.env.PATH, HOME: home, NODE_ENV: 'test',
  npm_config_userconfig: config, npm_config_globalconfig: resolve(base, 'global-npmrc'),
  npm_config_cache: resolve(base, 'cache'), npm_config_offline: 'true',
  npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
  npm_config_update_notifier: 'false' };
await writeFile(env.npm_config_globalconfig, '');
async function run(args: string[], cwd: string) {
  const child = Bun.spawn(['node', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(timer); }
}
const nodeVersion = await run(['--version'], base);
if (nodeVersion.exitCode !== 0 || nodeVersion.stdout.trim() !== 'v26.8.2') throw new Error('wrong Node oracle host');
const version = await run([cli, '--version'], base);
if (version.exitCode !== 0 || version.stdout.trim() !== '11.19.1') throw new Error('wrong npm CLI');
const results: Record<string, unknown> = {};
const compatibility: Record<string, string> = {};
for (const kind of npmNativeCases) {
  const request = npmFixture(kind);
  const directory = resolve(base, kind);
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  const manifest = Buffer.from(request.manifest.bytesBase64, 'base64');
  const lock = Buffer.from(request.lock.bytesBase64, 'base64');
  await writeFile(resolve(directory, 'package.json'), manifest);
  await writeFile(resolve(directory, 'package-lock.json'), lock);
  const listing = await run([cli, 'ls', '--all', '--json', '--long', '--package-lock-only',
    '--offline', '--ignore-scripts', '--strict-peer-deps', '--legacy-peer-deps=false'], directory);
  const virtual = await run([resolve(import.meta.dir, 'npm-native-tree.cjs'), npmPackage, directory], directory);
  if (virtual.exitCode !== 0) throw new Error(virtual.stderr);
  const native = JSON.parse(virtual.stdout) as { npmVersion: string; arboristVersion: string;
    nodes: Array<{ path: string; name: string; version: string; resolved: string | null;
      integrity: string | null; edges: Array<{ name: string; specifier: string;
        kind: string; to: string | null; error: string | null }> }> };
  const errors = native.nodes.flatMap(node => node.edges.filter(edge => edge.error)
    .map(edge => ({ from: node.path, ...edge })));
  const expected = kind === 'incompatible-peer' || kind === 'ancestor-shadow' ? 'INVALID'
    : kind === 'missing-peer' ? 'MISSING' : kind === 'child-local-peer' ? 'PEER LOCAL' : null;
  if (expected ? errors.length !== 1 || errors[0]!.error !== expected : errors.length) {
    throw new Error(`${kind}: unexpected native edge errors ${JSON.stringify(errors)}`);
  }
  if (!expected && listing.exitCode !== 0) throw new Error(`${kind}: ${listing.stderr}`);
  const rezics = validateNpmSnapshot(request);
  compatibility[kind] = npmSha(npmStable(rezics));
  const status = expected === 'MISSING' ? 'incomplete-source-data'
    : expected ? 'invalid-topology' : 'validated';
  if (rezics.status !== status) throw new Error(`${kind}: native/REZICS status differs: ${JSON.stringify(rezics)}`);
  if (!expected) {
    const nativeNodes = native.nodes.map(({ edges: _edges, ...node }) => node).sort((a, b) => a.path.localeCompare(b.path));
    const instances = rezics.instances.map(({ id: _id, peerHosts: _peerHosts, ...node }) => node)
      .sort((a, b) => a.path.localeCompare(b.path));
    if (npmStable(nativeNodes) !== npmStable(instances)) throw new Error(`${kind}: path/version/source/integrity differs`);
    const paths = new Map(rezics.instances.map(node => [node.id, node.path]));
    const edgeKey = (from: string, to: string | null, kind: string, name: string, specifier: string) =>
      JSON.stringify([from, to, kind, name, specifier]);
    const nativeEdges = native.nodes.flatMap(node => node.edges.map(edge => edgeKey(node.path,
      edge.to, edge.kind === 'prod' ? 'dependency' : edge.kind, edge.name, edge.specifier))).sort();
    const edges = rezics.edges.map(edge => edgeKey(paths.get(edge.from)!, paths.get(edge.to)!,
      edge.kind, edge.name, edge.specifier)).sort();
    if (npmStable(nativeEdges) !== npmStable(edges)) throw new Error(`${kind}: native edge/peer hosts differ`);
    for (const instance of rezics.instances) {
      const peers = native.nodes.find(node => node.path === instance.path)!.edges.filter(edge => edge.kind === 'peer')
        .map(edge => [edge.name, edge.specifier, edge.to]).sort();
      const hosts = instance.peerHosts.map(peer => {
        if (paths.get(peer.host) !== peer.path) throw new Error('peer host ID/path disagree');
        return [peer.name, peer.specifier, peer.path];
      }).sort();
      if (npmStable(peers) !== npmStable(hosts)) throw new Error(`${kind}: peer-host witness differs`);
    }
  } else {
    const issue = rezics.issues.find(item => item.path === errors[0]!.from && item.name === errors[0]!.name);
    if (!issue || issue.foundPath !== errors[0]!.to) throw new Error(`${kind}: rejected host differs`);
    if (rezics.instances.length || rezics.edges.length) throw new Error('failed topology leaked usable graph');
  }
  if (await readFile(resolve(directory, 'package.json'), 'base64') !== request.manifest.bytesBase64
    || await readFile(resolve(directory, 'package-lock.json'), 'base64') !== request.lock.bytesBase64) {
    throw new Error('native oracle changed exact input bytes');
  }
  if (await access(resolve(directory, 'node_modules')).then(() => true, () => false)) {
    throw new Error('native oracle unexpectedly installed packages');
  }
  results[kind] = { request, listing: { ...listing, stdout: JSON.parse(listing.stdout) }, native, rezics };
}
await writeFile(resolve(base, 'result.json'), JSON.stringify({ nodeVersion: nodeVersion.stdout.trim(),
  npmVersion: version.stdout.trim(), results }, null, 2));
console.log(`npm offline native topology matched ${npmNativeCases.length} scenarios; result: ${resolve(base, 'result.json')}`);
const platformResults: Record<string, unknown> = {};
const platformSummary: Record<string, unknown> = {};
const platformCompatibility: Record<string, string> = {};
for (const kind of npmPlatformCases) for (const target of npmTargets) {
  const request = npmPlatformFixture(kind, target);
  const key = `${kind}-${target.os}-${target.cpu}`;
  const directory = resolve(base, key);
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'package.json'), Buffer.from(request.manifest.bytesBase64, 'base64'));
  await writeFile(resolve(directory, 'package-lock.json'), Buffer.from(request.lock.bytesBase64, 'base64'));
  const virtual = await run([resolve(import.meta.dir, 'npm-native-tree.cjs'), npmPackage, directory,
    JSON.stringify(target)], directory);
  if (virtual.exitCode !== 0) throw new Error(virtual.stderr);
  const native = JSON.parse(virtual.stdout);
  const rezics = validateNpmPlatformSnapshot(request);
  compareNpmPlatform(key, native, rezics);
  platformCompatibility[key] = npmSha(npmStable(rezics));
  if (await readFile(resolve(directory, 'package.json'), 'base64') !== request.manifest.bytesBase64
    || await readFile(resolve(directory, 'package-lock.json'), 'base64') !== request.lock.bytesBase64) {
    throw new Error('native platform oracle changed exact input bytes');
  }
  if (await access(resolve(directory, 'node_modules')).then(() => true, () => false)) {
    throw new Error('native platform oracle unexpectedly installed packages');
  }
  platformResults[key] = { request, native, rezics };
  platformSummary[key] = { status: rezics.status, omissions: native.projection.omissions,
    errors: rezics.issues, cost: rezics.cost };
}
await writeFile(resolve(base, 'platform-result.json'), JSON.stringify(platformResults, null, 2));
console.log(`npm offline native platform comparison matched ${Object.keys(platformResults).length} cases; result: ${resolve(base, 'platform-result.json')}`);
const identityResults: Record<string, unknown> = {};
const identitySummary: Record<string, unknown> = {};
const identityCompatibility: Record<string, string> = {};
for (const kind of npmIdentityCases) {
  const request = npmIdentityFixture(kind);
  const directory = resolve(base, `identity-${kind}`);
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  const inputs = [{ path: 'package.json', bytes: request.manifest }, { path: 'package-lock.json', bytes: request.lock },
    ...request.workspaces.map(item => ({ path: `${item.path}/package.json`, bytes: item.manifest }))];
  for (const input of inputs) {
    await mkdir(dirname(resolve(directory, input.path)), { recursive: true });
    await writeFile(resolve(directory, input.path), Buffer.from(input.bytes.bytesBase64, 'base64'));
  }
  const listing = await run([cli, 'ls', '--all', '--json', '--long', '--package-lock-only',
    '--offline', '--ignore-scripts', '--strict-peer-deps', '--legacy-peer-deps=false'], directory);
  const virtual = await run([resolve(import.meta.dir, 'npm-native-tree.cjs'), npmPackage, directory, 'identity'], directory);
  const native = JSON.parse(virtual.stdout);
  let rezics: NpmIdentityOutcome | { status: 'rejected'; message: string };
  try { rezics = validateNpmIdentitySnapshot(request); }
  catch (error) {
    if (!(error instanceof NpmResolutionInvalid)) throw error;
    rezics = { status: 'rejected', message: error.message };
  }
  const policyDifference = compareNpmIdentity(kind, directory, native, rezics);
  identityCompatibility[kind] = npmSha(npmStable(rezics));
  for (const input of inputs) if (await readFile(resolve(directory, input.path), 'base64') !== input.bytes.bytesBase64) {
    throw new Error('native identity oracle changed exact input bytes');
  }
  for (const path of ['', ...request.workspaces.map(item => item.path)]) {
    if (await access(resolve(directory, path, 'node_modules')).then(() => true, () => false)) {
      throw new Error('native identity oracle unexpectedly installed packages');
    }
  }
  identityResults[kind] = { request, directory, listing, virtual, native, rezics, policyDifference };
  identitySummary[kind] = { status: rezics.status, policyDifference,
    ...(rezics.status === 'rejected' ? { message: rezics.message } : { issues: rezics.issues, cost: rezics.cost }) };
}
await writeFile(resolve(base, 'identity-result.json'), JSON.stringify(identityResults, null, 2));
await writeFile(resolve(base, 'summary.json'), JSON.stringify({ compatibility, platformCompatibility, identityCompatibility, platformSummary, identitySummary }, null, 2));
console.log(`npm offline native identity comparison matched ${npmIdentityCases.length} cases; result: ${resolve(base, 'identity-result.json')}`);
const compositionResults: Record<string, unknown> = {};
const compositionSummary: Record<string, unknown> = {};
for (const kind of npmCompositionCases) for (const target of npmCompositionTargets) {
  const request = npmCompositionFixture(kind, target);
  const key = `${kind}-${target.os}-${target.cpu}`;
  const directory = resolve(base, `composition-${key}`);
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  const inputs = [{ path: 'package.json', bytes: request.manifest }, { path: 'package-lock.json', bytes: request.lock },
    ...request.workspaces.map(item => ({ path: `${item.path}/package.json`, bytes: item.manifest }))];
  for (const input of inputs) {
    await mkdir(dirname(resolve(directory, input.path)), { recursive: true });
    await writeFile(resolve(directory, input.path), Buffer.from(input.bytes.bytesBase64, 'base64'));
  }
  const virtual = await run([resolve(import.meta.dir, 'npm-native-tree.cjs'), npmPackage, directory,
    'composition', JSON.stringify(target)], directory);
  const native = JSON.parse(virtual.stdout);
  let rezics: NpmCompositionOutcome | { status: 'rejected'; message: string };
  try { rezics = validateNpmCompositionSnapshot(request); }
  catch (error) {
    if (!(error instanceof NpmResolutionInvalid)) throw error;
    rezics = { status: 'rejected', message: error.message };
  }
  // Persist the observation before asserting, including any native/profile disagreement.
  compositionResults[key] = { request, directory, virtual, native, rezics };
  await writeFile(resolve(base, 'composition-result.json'), JSON.stringify(compositionResults, null, 2));
  const policyDifference = compareNpmComposition(kind, directory, native, rezics);
  for (const input of inputs) if (await readFile(resolve(directory, input.path), 'base64') !== input.bytes.bytesBase64) {
    throw new Error('native composition oracle changed exact input bytes');
  }
  for (const path of ['', ...request.workspaces.map(item => item.path)]) {
    if (await access(resolve(directory, path, 'node_modules')).then(() => true, () => false)) {
      throw new Error('native composition oracle unexpectedly installed packages');
    }
  }
  compositionResults[key] = { request, directory, virtual, native, rezics, policyDifference };
  compositionSummary[key] = { status: rezics.status, policyDifference,
    ...(rezics.status === 'rejected' ? { message: rezics.message } : { issues: rezics.issues, cost: rezics.cost }) };
}
await writeFile(resolve(base, 'composition-result.json'), JSON.stringify(compositionResults, null, 2));
await writeFile(resolve(base, 'summary.json'), JSON.stringify({ compatibility, platformCompatibility, identityCompatibility,
  platformSummary, identitySummary, compositionSummary }, null, 2));
console.log(`npm offline native composition matched ${Object.keys(compositionResults).length} cases; result: ${resolve(base, 'composition-result.json')}`);
