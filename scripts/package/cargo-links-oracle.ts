import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { solveCargoSnapshot } from '../../services/main/src/modules/package/cargo-resolution.ts';
import { cargoIndexEntries, cargoIndexFile, cargoLinksCases, cargoLinksFixture,
  type CargoIndexEntry } from '../../tests/qa/fixtures/cargo-links-snapshot.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function manifest(entry: CargoIndexEntry): string {
  const features = Object.entries(entry.features)
    .map(([name, values]) => `${name} = ${JSON.stringify(values)}`).join('\n');
  const dependencies = entry.deps.map(dep => `${dep.name} = { version = "${dep.req}",
registry = "snapshot", default-features = ${dep.default_features}, optional = ${dep.optional},
features = ${JSON.stringify(dep.features)} }`.replaceAll('\n', ' ')).join('\n');
  return `[package]\nname = "${entry.name}"\nversion = "${entry.vers}"\nedition = "2021"\n`
    + (entry.links ? `links = "${entry.links}"\nbuild = "build.rs"\n` : '')
    + `\n[features]\n${features}\n\n[dependencies]\n${dependencies}\n`;
}

export async function verifyCargoLinksOracle(base: string, cargo: string,
  crate: (name: string, version: string, manifest: string, links?: boolean) => Uint8Array,
  indexPath: (name: string) => string): Promise<void> {
  const results: Record<string, unknown> = {};
  for (const kind of cargoLinksCases) {
    const directory = resolve(base, 'links', kind);
    const project = resolve(directory, 'root');
    const home = resolve(directory, 'cargo-home');
    await mkdir(resolve(project, 'src'), { recursive: true });
    await mkdir(home, { recursive: true });
    const request = cargoLinksFixture(kind);
    const entries = cargoIndexEntries(request);
    const archives = new Map<string, Uint8Array>();
    for (const entry of entries) {
      const archive = crate(entry.name, entry.vers, manifest(entry), Boolean(entry.links));
      entry.cksum = hash(archive);
      archives.set(`${entry.name}/${entry.vers}`, archive);
    }
    request.indexFiles = request.indexFiles.map(file => cargoIndexFile(file.name,
      entries.filter(entry => entry.name === file.name)));
    const indexes = new Map(request.indexFiles.map(file => [indexPath(file.name),
      Buffer.from(file.bytesBase64, 'base64').toString('utf8')]));
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/index/config.json') return Response.json({
        dl: `http://127.0.0.1:${server.port}/crates` });
      const index = indexes.get(path.replace(/^\/index\//, ''));
      if (path.startsWith('/index/') && index) return new Response(index);
      const match = /^\/crates\/([^/]+)\/([^/]+)\/download$/.exec(path);
      const archive = match ? archives.get(`${match[1]}/${match[2]}`) : null;
      return archive ? new Response(archive) : new Response('not found', { status: 404 });
    } });
    try {
      const nativeSource = `sparse+http://127.0.0.1:${server.port}/index/`;
      await writeFile(resolve(home, 'config.toml'), `[registries.snapshot]\nindex = "${nativeSource}"\n`);
      await writeFile(resolve(project, 'Cargo.toml'), Buffer.from(request.manifestBase64, 'base64'));
      await writeFile(resolve(project, 'src/lib.rs'), 'pub fn fixture() {}\n');
      const process = Bun.spawn([cargo, 'metadata', '--format-version', '1',
        '--manifest-path', resolve(project, 'Cargo.toml'), '--filter-platform', request.target,
        ...(!request.defaultFeatures ? ['--no-default-features'] : [])], {
        cwd: project, env: { ...Bun.env, CARGO_HOME: home,
          CARGO_TARGET_DIR: resolve(directory, 'target'), CARGO_NET_RETRY: '0',
          CARGO_HTTP_TIMEOUT: '10' }, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      const conflict = !['distinct-links', 'single-owner', 'single-owner-no-default',
        'single-owner-windows', 'inactive-transitive-optional'].includes(kind);
      if (conflict ? exitCode === 0 || !stderr.includes('links to the native library `native_shared`')
        : exitCode !== 0) throw new Error(`${kind}: unexpected Cargo outcome: ${stderr}`);
      const rezics = solveCargoSnapshot(request);
      if (rezics.status !== (conflict ? 'unsatisfiable' : 'solved')) {
        throw new Error(`${kind}: REZICS/native status differs: ${JSON.stringify(rezics)}`);
      }
      if (conflict) {
        const second = kind === 'different-names' ? 'bridge@1.0.0'
          : kind === 'inactive-target' ? 'windowsonly@1.0.0'
            : kind === 'inactive-root-optional' ? 'optionaldep@1.0.0' : 'shared@2.0.0';
        const expected = ['shared@1.0.0', second].sort();
        const actual = rezics.linksConflicts?.flatMap(item => item.packages.map(pkg => {
          if (item.links !== 'native_shared' || pkg.id !== `${request.registryIndexUrl}#${pkg.name}@${pkg.version}`
            || pkg.source !== request.registryIndexUrl) throw new Error(`${kind}: conflict identity differs`);
          return `${pkg.name}@${pkg.version}`;
        })).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`${kind}: conflict witness differs: ${JSON.stringify(actual)}`);
        }
      }
      let selected: string[] = [];
      const metadata = stdout ? JSON.parse(stdout) as { packages: Array<{ id: string;
        name: string; version: string; source: string | null; links: string | null }>;
        resolve: { nodes: Array<{ id: string; features: string[]; deps: Array<{ pkg: string;
          dep_kinds: Array<{ kind: string | null; target: string | null }> }> }> } } : null;
      if (!conflict) {
        const lock = Bun.TOML.parse(await readFile(resolve(project, 'Cargo.lock'), 'utf8')) as {
          package: Array<{ name: string; version: string; source?: string }> };
        selected = lock.package.filter(item => item.source).map(item => {
          if (item.source !== nativeSource) throw new Error('native source differs');
          return `${request.registryIndexUrl}#${item.name}@${item.version}`;
        }).sort();
        if (selected.some(id => id.endsWith('@3.0.0'))) throw new Error('unselected release leaked');
        if (JSON.stringify(selected) !== JSON.stringify(rezics.selected.map(item => item.id).sort())) {
          throw new Error(`${kind}: native/REZICS lock identities differ`);
        }
        const nativeIds = new Map<string, string>();
        for (const pkg of metadata!.packages) {
          if (pkg.source && pkg.source !== nativeSource) throw new Error('native metadata source differs');
          const id = `${pkg.source ? request.registryIndexUrl : 'root'}#${pkg.name}@${pkg.version}`;
          nativeIds.set(pkg.id, id);
          if (pkg.source && pkg.links !== (entries.find(entry => entry.name === pkg.name
            && entry.vers === pkg.version)?.links ?? null)) throw new Error('native links metadata differs');
        }
        const nativeEdges = metadata!.resolve.nodes.flatMap(node => node.deps.flatMap(dep =>
          dep.dep_kinds.map(edge => `${nativeIds.get(node.id)}|${nativeIds.get(dep.pkg)}|${edge.kind ?? 'normal'}|${edge.target ?? ''}`))).sort();
        const rezicsEdges = [...new Set(rezics.edges.map(edge =>
          `${edge.from.replace(/#(?:host|target)$/, '')}|${edge.to.replace(/#(?:host|target)$/, '')}|${edge.kind}|${edge.target ?? ''}`))].sort();
        if (JSON.stringify(nativeEdges) !== JSON.stringify(rezicsEdges)) {
          throw new Error(`${kind}: native/REZICS active edges differ`);
        }
        for (const node of metadata!.resolve.nodes) {
          const features = [...new Set(rezics.instances.filter(instance =>
            instance.id.replace(/#(?:host|target)$/, '') === nativeIds.get(node.id))
            .flatMap(instance => instance.features))].sort();
          if (JSON.stringify(features) !== JSON.stringify([...node.features].sort())) {
            throw new Error(`${kind}: native/REZICS feature union differs`);
          }
        }
      }
      results[kind] = { status: conflict ? 'unsatisfiable' : 'solved', exitCode,
        selected, stderr, metadata, request, rezics };
    } finally { server.stop(true); }
  }
  await writeFile(resolve(base, 'links-result.json'), JSON.stringify(results, null, 2));
  console.log(`Cargo links oracle matched ${cargoLinksCases.length} scenarios; result: ${resolve(base, 'links-result.json')}`);
}
