import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { solveCargoRegistry } from '../../services/main/src/modules/package/cargo-solver.ts';
import { CARGO_LIVE_HOST, CARGO_LIVE_REGISTRY, CARGO_LIVE_SCENARIOS, cargoIndexPath,
  type CargoLiveScenario } from '../../tests/qa/fixtures/cargo-live-scenarios.ts';
import { CARGO_SYNTHETIC_PROC_MACROS, CARGO_SYNTHETIC_SCENARIOS, cargoSyntheticIndex }
  from '../../tests/qa/fixtures/cargo-synthetic-registry.ts';
import { cargoLiveIndex, cargoLiveProcMacros, cargoNativeView, type CargoNativeVariant }
  from '../../tests/qa/fixtures/cargo-live-snapshot.ts';

// Native Cargo 1.98.1 over the retained live crates.io capture. A loopback sparse
// registry serves the captured index records; each crate archive is synthesized
// from its own index record (dependencies, features, links, proc-macro fact), so
// Cargo's downloaded manifest and index agree. Checksums are the synthesized
// archives' digests. Lock selection, lock edges and `cargo tree` feature
// instances per target are compared with the REZICS solver.

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const nativeRecord = resolve(import.meta.dir, '../../tests/qa/fixtures/cargo-live-native.json');

type Crate = (name: string, version: string, manifest: string, links?: boolean) => Uint8Array;
interface IndexDep { name: string; req: string; features?: string[]; optional?: boolean;
  default_features?: boolean; target?: string | null; kind?: string | null; package?: string | null }
interface IndexLine { name: string; vers: string; deps: IndexDep[]; cksum: string;
  features?: Record<string, string[]>; features2?: Record<string, string[]>;
  links?: string | null; yanked?: boolean; v?: number; rust_version?: string }

const toml = (value: unknown) => JSON.stringify(value);

function manifestFor(line: IndexLine, procMacro: boolean): string {
  const tables = new Map<string, string[]>();
  for (const dep of line.deps) {
    const kind = dep.kind === 'build' ? 'build-dependencies' : dep.kind === 'dev'
      ? 'dev-dependencies' : 'dependencies';
    const table = dep.target ? `target.${toml(dep.target)}.${kind}` : kind;
    const fields = [`version = ${toml(dep.req)}`];
    if (dep.package) fields.push(`package = ${toml(dep.package)}`);
    if (dep.optional) fields.push('optional = true');
    if (dep.default_features === false) fields.push('default-features = false');
    if (dep.features?.length) fields.push(`features = ${toml(dep.features)}`);
    const rows = tables.get(table) ?? [];
    rows.push(`${toml(dep.name)} = { ${fields.join(', ')} }`);
    tables.set(table, rows);
  }
  const features = { ...line.features ?? {} };
  for (const [name, values] of Object.entries(line.features2 ?? {})) {
    features[name] = [...features[name] ?? [], ...values];
  }
  return [`[package]\nname = ${toml(line.name)}\nversion = ${toml(line.vers)}\nedition = "2021"`
    + (line.links ? `\nlinks = ${toml(line.links)}\nbuild = "build.rs"` : ''),
  procMacro ? '[lib]\nproc-macro = true' : '',
  `[features]\n${Object.entries(features).map(([name, values]) =>
    `${toml(name)} = ${toml(values)}`).join('\n')}`,
  ...[...tables].map(([table, rows]) => `[${table}]\n${rows.join('\n')}`)].join('\n\n') + '\n';
}

function parseTree(text: string, rootName: string): string[] {
  // `--prefix indent --format {p}|{f}`: 4 columns per level; section headers
  // such as `[build-dependencies]` apply to the following siblings.
  const instances = new Set<string>();
  const stack: Array<{ role: 'host' | 'target'; section: string }> = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    const prefix = /^(?:│   |    |├── |└── )*/.exec(raw)![0];
    const depth = prefix.length / 4;
    const body = raw.slice(prefix.length);
    const header = /^\[(build|dev)-dependencies\]$/.exec(body);
    if (header) { stack.length = depth + 1; stack[depth]!.section = header[1]!; continue; }
    const item = /^(\S+) v(\S+)( \(proc-macro\))?(?: \([^)]*\))?(?: \(\*\))?\|(.*)$/.exec(body);
    if (!item) throw new Error(`unparsed cargo tree line: ${raw}`);
    const [, name, version, proc, features] = item;
    stack.length = depth;
    const parent = stack[depth - 1];
    const role = !parent ? 'target' : parent.role === 'host' || parent.section === 'build' || proc
      ? 'host' : 'target';
    stack.push({ role, section: 'normal' });
    if (!parent && name === rootName) continue;
    instances.add(`${name}@${version}#${role}|${features!.split(',').filter(Boolean).sort().join(',')}`);
  }
  return [...instances].sort();
}

interface Comparison { native: Record<string, CargoNativeVariant>; compared: Record<string, unknown>;
  mismatches: string[]; requested: Set<string> }

async function compareRegistry(directory: string, cargo: string, crate: Crate,
  captured: Map<string, Uint8Array>, procMacros: Set<string>, scenarios: CargoLiveScenario[],
  { native, compared, mismatches, requested }: Comparison): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(resolve(directory, 'cargo-home'), { recursive: true });
  const archives = new Map<string, Uint8Array>();
  const served = new Map<string, string>();
  for (const [name, bytes] of captured) {
    const lines = new TextDecoder().decode(bytes).split('\n').filter(Boolean).map(raw => {
      const line = JSON.parse(raw) as IndexLine;
      const archive = crate(line.name, line.vers,
        manifestFor(line, procMacros.has(`${line.name}@${line.vers}`)), Boolean(line.links));
      archives.set(`${line.name}/${line.vers}`, archive);
      return JSON.stringify({ ...line, cksum: hash(archive) });
    });
    served.set(cargoIndexPath(name), `${lines.join('\n')}\n`);
  }
  const server: Bun.Server<undefined> = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req): Response {
    const path = new URL(req.url).pathname;
    if (path === '/index/config.json') return Response.json({ dl: `http://127.0.0.1:${server.port}/crates` });
    if (path.startsWith('/index/')) {
      const key = path.slice('/index/'.length);
      requested.add(key);
      const index = served.get(key);
      return index ? new Response(index) : new Response('not found', { status: 404 });
    }
    const match = /^\/crates\/([^/]+)\/([^/]+)\/download$/.exec(path);
    const archive = match ? archives.get(`${match[1]}/${match[2]}`) : undefined;
    return archive ? new Response(new Uint8Array(archive)) : new Response('not found', { status: 404 });
  } });
  const run = async (cwd: string, args: string[]) => {
    const child = Bun.spawn([cargo, ...args], { cwd, stdout: 'pipe', stderr: 'pipe',
      env: { ...Bun.env, CARGO_HOME: resolve(directory, 'cargo-home'),
        CARGO_TARGET_DIR: resolve(directory, 'target'), CARGO_NET_RETRY: '0',
        CARGO_HTTP_TIMEOUT: '10', CARGO_TERM_COLOR: 'never' } });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  };
  try {
    await writeFile(resolve(directory, 'cargo-home/config.toml'),
      `[source.crates-io]\nreplace-with = "snapshot"\n\n[source.snapshot]\n`
      + `registry = "sparse+http://127.0.0.1:${server.port}/index/"\n`);
    for (const scenario of scenarios) {
      const project = resolve(directory, 'work', scenario.id);
      await mkdir(resolve(project, 'src'), { recursive: true });
      await writeFile(resolve(project, 'Cargo.toml'), scenario.manifest);
      await writeFile(resolve(project, 'src/lib.rs'), 'pub fn fixture() {}\n');
      const lock = await run(project, ['generate-lockfile']);
      const rootName = /name = "([^"]+)"/.exec(scenario.manifest)![1]!;
      let selected: string[] = [];
      let lockEdges: string[] = [];
      if (lock.exitCode === 0) {
        const parsed = Bun.TOML.parse(await readFile(resolve(project, 'Cargo.lock'), 'utf8')) as {
          package: Array<{ name: string; version: string; dependencies?: string[] }> };
        const versions = new Map<string, string[]>();
        for (const item of parsed.package) versions.set(item.name, [...versions.get(item.name) ?? [], item.version]);
        const ident = (item: { name: string; version: string }) =>
          item.name === rootName ? rootName : `${item.name}@${item.version}`;
        selected = parsed.package.filter(item => item.name !== rootName).map(ident).sort();
        lockEdges = [...new Set(parsed.package.flatMap(item => (item.dependencies ?? []).map(dep => {
          const [name, version] = dep.split(' ') as [string, string | undefined];
          const target = version ?? versions.get(name)![0]!;
          return `${ident(item)}->${name === rootName ? rootName : `${name}@${target}`}`;
        })))].sort();
      }
      for (const variant of scenario.variants) {
        const label = `${scenario.id}/${variant.label}`;
        let instances: string[] = [];
        let error: string | null = null;
        if (lock.exitCode === 0) {
          const tree = await run(project, ['tree', '--target', variant.target,
            '-e', variant.includeDev ? 'normal,build,dev' : 'normal,build', '--no-dedupe',
            '--prefix', 'indent', '--format', '{p}|{f}',
            ...variant.defaultFeatures ? [] : ['--no-default-features'],
            ...variant.features.length ? ['--features', variant.features.join(',')] : []]);
          if (tree.exitCode !== 0) throw new Error(`${label}: cargo tree failed: ${tree.stderr}`);
          await writeFile(resolve(project, `${variant.label}.tree`), tree.stdout);
          instances = parseTree(tree.stdout, rootName);
        } else {
          error = lock.stderr.replaceAll(project, '<project>').split('\n').filter(Boolean)
            .slice(0, 8).join('\n');
        }
        const nativeView: CargoNativeVariant = { status: lock.exitCode === 0 ? 'solved' : 'failed',
          selected, lockEdges, instances, error };
        native[label] = nativeView;
        const outcome = await solveCargoRegistry({ registryIndexUrl: CARGO_LIVE_REGISTRY,
          manifest: scenario.manifest, host: CARGO_LIVE_HOST, target: variant.target,
          features: variant.features, defaultFeatures: variant.defaultFeatures,
          includeDev: variant.includeDev, procMacros: [...procMacros],
          loadIndex: async name => captured.get(name) ?? null });
        const view = cargoNativeView(outcome);
        const same = view.status === nativeView.status
          && JSON.stringify(view.selected) === JSON.stringify(nativeView.selected)
          && JSON.stringify(view.lockEdges) === JSON.stringify(nativeView.lockEdges)
          && JSON.stringify(view.instances) === JSON.stringify(nativeView.instances);
        if (!same) mismatches.push(label);
        compared[label] = { same, rezicsStatus: outcome.status, native: nativeView, rezics: view,
          conflicts: outcome.conflicts, cost: outcome.cost };
      }
    }
  } finally { await server.stop(true); }
}

export async function verifyCargoLiveOracle(base: string, cargo: string, crate: Crate): Promise<void> {
  const comparison: Comparison = { native: {}, compared: {}, mismatches: [], requested: new Set() };
  await compareRegistry(resolve(base, 'live'), cargo, crate, cargoLiveIndex(),
    new Set(cargoLiveProcMacros()), CARGO_LIVE_SCENARIOS, comparison);
  await compareRegistry(resolve(base, 'synthetic'), cargo, crate, cargoSyntheticIndex(),
    new Set(CARGO_SYNTHETIC_PROC_MACROS), CARGO_SYNTHETIC_SCENARIOS, comparison);
  const { native, compared, mismatches, requested } = comparison;
  await writeFile(resolve(base, 'live-result.json'), JSON.stringify({ compared,
    requestedIndexPaths: [...requested].sort() }, null, 2));
  if (mismatches.length) {
    throw new Error(`native Cargo live comparison mismatch: ${mismatches.join(', ')}; `
      + `see ${resolve(base, 'live-result.json')}`);
  }
  await writeFile(nativeRecord, `${JSON.stringify({ cargo: '1.98.1', variants: native }, null, 2)}\n`);
  console.log(`Cargo live oracle matched ${Object.keys(compared).length} scenario variants; `
    + `native record: ${nativeRecord}`);
}

if (import.meta.main) {
  const cargo = Bun.which('cargo');
  if (!cargo) throw new Error('Cargo 1.98.1 is not installed');
  const version = Bun.spawnSync([cargo, '--version']).stdout.toString().trim();
  if (version !== 'cargo 1.98.1 (797e8a9bc 2026-08-05)') throw new Error(`Cargo pin mismatch: ${version}`);
  const { crate } = await import('./cargo-crate.ts');
  await verifyCargoLiveOracle(resolve('.temp/package-cargo-oracle'), cargo, crate);
}
