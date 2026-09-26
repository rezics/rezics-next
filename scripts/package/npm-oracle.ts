import { mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { npmFixture, npmNativeCases } from '../../tests/qa/fixtures/npm-lock-snapshot.ts';
import { npmStable, validateNpmSnapshot } from '../../services/main/src/modules/package/npm-lock.ts';

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
