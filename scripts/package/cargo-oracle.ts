import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { solveCargoSnapshot, type CargoRequest }
  from '../../services/main/src/modules/package/cargo-resolution.ts';
import { verifyCargoLinksOracle } from './cargo-links-oracle.ts';

const base = resolve('.temp/package-cargo-oracle');
const cargo = Bun.which('cargo');
if (!cargo) throw new Error('Cargo 1.98.1 is not installed');
const source = 'https://snapshot.example.invalid/index/';
const target = 'x86_64-unknown-linux-gnu';
const encoder = new TextEncoder();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const b64 = (text: string) => Buffer.from(text).toString('base64');

async function run(args: string[], env: Record<string, string> = {}): Promise<{
  stdout: string; stderr: string; exitCode: number }> {
  const process = Bun.spawn([cargo, ...args], { cwd: base,
    env: { ...Bun.env, CARGO_HOME: resolve(base, 'cargo-home'),
      CARGO_TARGET_DIR: resolve(base, 'target'), CARGO_NET_RETRY: '0',
      CARGO_HTTP_TIMEOUT: '10', ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { stdout, stderr, exitCode };
}

function tarFile(path: string, bytes: Uint8Array): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - bytes.length % 512) % 512);
  return Buffer.concat([header, bytes, padding]);
}
function crate(name: string, version: string, manifest: string, links = false): Uint8Array {
  const prefix = `${name}-${version}`;
  const archive = Buffer.concat([tarFile(`${prefix}/Cargo.toml`, encoder.encode(manifest)),
    tarFile(`${prefix}/src/lib.rs`, encoder.encode('pub fn fixture() {}\n')),
    ...(links ? [tarFile(`${prefix}/build.rs`, encoder.encode(
      'fn main() { panic!("oracle must not run build scripts"); }\n'))] : []),
    Buffer.alloc(1024)]);
  return gzipSync(archive, { mtime: 0 } as never);
}
function indexPath(name: string): string {
  const lower = name.toLowerCase();
  return lower.length === 1 ? `1/${lower}` : lower.length === 2 ? `2/${lower}`
    : lower.length === 3 ? `3/${lower[0]}/${lower}`
      : `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}
const rootManifest = `[package]
name = "cargo-root"
version = "0.1.0"
edition = "2021"
resolver = "2"

[dependencies]
shared = { version = "=1.0.0", registry = "snapshot", default-features = false, features = ["runtime"] }
bridge = { version = "=1.0.0", registry = "snapshot" }
hostdep = { version = "=1.0.0", registry = "snapshot", optional = true }

[build-dependencies]
shared = { version = "=1.0.0", registry = "snapshot", default-features = false, features = ["build_extra"] }

[target.'cfg(target_os = "windows")'.dependencies]
windowsonly = { version = "=1.0.0", registry = "snapshot" }

[features]
default = ["dep:hostdep"]
`;
const packages = [
  { name: 'shared', version: '1.0.0', features: { runtime: [], build_extra: [],
    indirect: [] }, dependencies: [] },
  { name: 'bridge', version: '1.0.0', features: {}, dependencies: [{
    name: 'shared', req: '=1.0.0', features: ['indirect'], optional: false,
    default_features: false, target: null, kind: 'normal', registry: null,
    package: null }] },
  { name: 'hostdep', version: '1.0.0', features: {}, dependencies: [] },
  { name: 'windowsonly', version: '1.0.0', features: {}, dependencies: [] },
];

await mkdir(base, { recursive: true });
const version = await run(['--version']);
if (version.exitCode !== 0 || version.stdout.trim() !== 'cargo 1.98.1 (797e8a9bc 2026-08-05)') {
  throw new Error(`Cargo pin mismatch: ${version.stdout.trim()} ${version.stderr.trim()}`);
}
await rm(resolve(base, 'work'), { recursive: true, force: true });
await rm(resolve(base, 'cargo-home'), { recursive: true, force: true });
await rm(resolve(base, 'links'), { recursive: true, force: true });
await rm(resolve(base, 'links-result.json'), { force: true });
await mkdir(resolve(base, 'work'), { recursive: true });
await mkdir(resolve(base, 'cargo-home'), { recursive: true });
const archives = new Map<string, Uint8Array>();
const indexes = new Map<string, string>();
for (const item of packages) {
  const featureTable = Object.entries(item.features).map(([name, values]) =>
    `${name} = ${JSON.stringify(values)}`).join('\n');
  const dependencyTable = item.dependencies.map(dep =>
    `${dep.name} = { version = "${dep.req}", registry = "snapshot", default-features = false, features = ["indirect"] }`).join('\n');
  const manifest = `[package]\nname = "${item.name}"\nversion = "${item.version}"\nedition = "2021"\n\n[features]\n${featureTable}\n\n[dependencies]\n${dependencyTable}\n`;
  const archive = crate(item.name, item.version, manifest);
  archives.set(`${item.name}/${item.version}`, archive);
  const line = JSON.stringify({ name: item.name, vers: item.version, deps: item.dependencies,
    cksum: hash(archive), features: item.features, yanked: false, v: 1 });
  indexes.set(indexPath(item.name), `${line}\n`);
}
const request: CargoRequest = { profile: 'cargo-index-exact-resolver2-v1',
  registryIndexUrl: source, manifestBase64: b64(rootManifest),
  manifestSha256: hash(encoder.encode(rootManifest)),
  indexFiles: packages.map(item => { const bytes = indexes.get(indexPath(item.name))!;
    return { name: item.name, bytesBase64: b64(bytes),
      sha256: hash(encoder.encode(bytes)) }; }),
  host: target, target, features: [], defaultFeatures: true };
const rezics = solveCargoSnapshot(request);
if (rezics.status !== 'solved') throw new Error(`REZICS did not solve fixture: ${JSON.stringify(rezics)}`);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/index/config.json') return Response.json({
      dl: `http://127.0.0.1:${server.port}/crates` });
    const index = indexes.get(path.replace(/^\/index\//, ''));
    if (path.startsWith('/index/') && index) return new Response(index,
      { headers: { 'content-type': 'text/plain', etag: hash(encoder.encode(index)) } });
    const match = /^\/crates\/([^/]+)\/([^/]+)\/download$/.exec(path);
    const archive = match ? archives.get(`${match[1]}/${match[2]}`) : null;
    if (archive) return new Response(archive);
    return new Response('not found', { status: 404 });
  } });
try {
  const config = `[registries.snapshot]\nindex = "sparse+http://127.0.0.1:${server.port}/index/"\n`;
  await writeFile(resolve(base, 'cargo-home/config.toml'), config);
  const project = resolve(base, 'work/root');
  await mkdir(resolve(project, 'src'), { recursive: true });
  await writeFile(resolve(project, 'Cargo.toml'), rootManifest);
  await writeFile(resolve(project, 'src/lib.rs'), 'pub fn fixture() {}\n');
  const native = await run(['metadata', '--format-version', '1', '--manifest-path',
    resolve(project, 'Cargo.toml'), '--filter-platform', target]);
  if (native.exitCode !== 0) throw new Error(`native Cargo metadata failed: ${native.stderr}`);
  const metadata = JSON.parse(native.stdout) as { packages: Array<{ name: string; version: string }>;
    resolve: { nodes: Array<{ id: string; deps: Array<{ name: string; pkg: string;
      dep_kinds: Array<{ kind: string | null; target: string | null }> }>;
      features: string[] }> } };
  const lockText = await readFile(resolve(project, 'Cargo.lock'), 'utf8');
  const lock = Bun.TOML.parse(lockText) as { package: Array<{ name: string; version: string }> };
  const expected = rezics.selected.map(item => `${item.name}@${item.version}`).sort();
  const selected = lock.package.filter(item => item.name !== 'cargo-root')
    .map(item => `${item.name}@${item.version}`).sort();
  if (JSON.stringify(expected) !== JSON.stringify(selected)) {
    throw new Error(`native lock selection mismatch: ${JSON.stringify({ expected, selected })}`);
  }
  const edgeNames = (graph: typeof rezics) => graph.edges
    .filter(edge => edge.from.startsWith('root#')).map(edge => {
      const instance = graph.instances.find(item => item.id === edge.to);
      if (!instance) throw new Error(`missing REZICS instance ${edge.to}`);
      return `${instance.name}:${edge.kind}:${edge.target ?? ''}`;
    }).sort();
  const nativeEdgeNames = (nativeGraph: typeof metadata) => {
    const node = nativeGraph.resolve.nodes.find(item => item.id.includes('cargo-root'));
    if (!node) throw new Error('native Cargo root node missing');
    return node.deps.flatMap(dep => dep.dep_kinds.map(kind =>
      `${dep.name}:${kind.kind ?? 'normal'}:${kind.target ?? ''}`)).sort();
  };
  const nativeEdges = nativeEdgeNames(metadata);
  const rezicsEdges = edgeNames(rezics);
  if (JSON.stringify(nativeEdges) !== JSON.stringify(rezicsEdges)) {
    throw new Error(`native active edges mismatch: ${JSON.stringify({ nativeEdges, rezicsEdges })}`);
  }
  const tree = await run(['tree', '--manifest-path', resolve(project, 'Cargo.toml'),
    '--target', target, '--edges', 'normal,build,features', '--prefix', 'depth']);
  if (tree.exitCode !== 0) throw new Error(`native Cargo tree failed: ${tree.stderr}`);
  for (const feature of ['runtime', 'build_extra', 'indirect']) {
    if (!tree.stdout.includes(feature)) throw new Error(`native Cargo feature ${feature} missing`);
  }
  for (const branch of ['1shared feature "runtime"',
    '1shared feature "build_extra"', '3shared feature "indirect"']) {
    if (!tree.stdout.split('\n').includes(branch)) {
      throw new Error(`native Cargo feature branch missing: ${branch}`);
    }
  }
  const sharedNode = metadata.resolve.nodes.find(node => node.id.includes('#shared@1.0.0'));
  if (JSON.stringify(sharedNode?.features.slice().sort())
    !== JSON.stringify(['build_extra', 'indirect', 'runtime'])) {
    throw new Error('native Cargo shared feature union mismatch');
  }
  const targetShared = rezics.instances.find(item => item.name === 'shared'
    && item.role === 'target');
  const hostShared = rezics.instances.find(item => item.name === 'shared'
    && item.role === 'host');
  if (JSON.stringify(targetShared?.features) !== JSON.stringify(['indirect', 'runtime'])
    || JSON.stringify(hostShared?.features) !== JSON.stringify(['build_extra'])) {
    throw new Error('REZICS feature unification or host split mismatch');
  }
  const variants: Array<{ label: string; request: CargoRequest; args: string[] }> = [
    { label: 'no-default-features', request: { ...request, defaultFeatures: false },
      args: ['--no-default-features'] },
    { label: 'windows-target', request: { ...request,
      target: 'x86_64-pc-windows-msvc' },
    args: ['--filter-platform', 'x86_64-pc-windows-msvc'] },
  ];
  const comparedVariants: Record<string, unknown> = {};
  for (const variant of variants) {
    const result = solveCargoSnapshot(variant.request);
    if (result.status !== 'solved') throw new Error(`${variant.label}: REZICS did not solve`);
    const nativeVariant = await run(['metadata', '--format-version', '1',
      '--manifest-path', resolve(project, 'Cargo.toml'),
      ...(variant.label === 'no-default-features' ? ['--filter-platform', target] : []),
      ...variant.args]);
    if (nativeVariant.exitCode !== 0) throw new Error(`${variant.label}: ${nativeVariant.stderr}`);
    const parsed = JSON.parse(nativeVariant.stdout) as typeof metadata;
    const actual = nativeEdgeNames(parsed);
    const expectedEdges = edgeNames(result);
    if (JSON.stringify(actual) !== JSON.stringify(expectedEdges)) {
      throw new Error(`${variant.label} edges mismatch: ${JSON.stringify({ actual, expectedEdges })}`);
    }
    comparedVariants[variant.label] = { nativeEdges: actual,
      rezicsEdges: expectedEdges, rezics: result };
  }
  const result = { cargoVersion: version.stdout.trim(), target,
    selected, nativeEdges, rezicsEdges, rezics, nativeLock: lock,
    nativeMetadata: metadata,
    nativeTree: tree.stdout, comparedVariants };
  await writeFile(resolve(base, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`Cargo oracle matched ${selected.length} selected packages and ${nativeEdges.length} root edges; result: ${resolve(base, 'result.json')}`);
} finally { server.stop(true); }
await verifyCargoLinksOracle(base, cargo, crate, indexPath);
