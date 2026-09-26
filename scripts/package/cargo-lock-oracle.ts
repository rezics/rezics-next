import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CargoResolutionInvalid, solveCargoSnapshot }
  from '../../services/main/src/modules/package/cargo-resolution.ts';
import { cargoLockCases, cargoLockFixture, withCargoLock }
  from '../../tests/qa/fixtures/cargo-lock-snapshot.ts';
import { cargoIndexEntries, cargoIndexFile } from '../../tests/qa/fixtures/cargo-links-snapshot.ts';

export async function verifyCargoLockOracle(base: string, cargo: string,
  crate: (name: string, version: string, manifest: string, links?: boolean) => Uint8Array,
  indexPath: (name: string) => string): Promise<void> {
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const directory = resolve(base, 'locked');
  await rm(directory, { recursive: true, force: true });
  await rm(resolve(base, 'lock-result.json'), { force: true });
  const registry = cargoLockFixture().registryIndexUrl;
  const archives = new Map<string, Uint8Array>();
  const checksums = new Map<string, string>();
  for (const entry of cargoIndexEntries(cargoLockFixture('links-conflict'))) {
    const bytes = crate(entry.name, entry.vers,
      `[package]\nname = "${entry.name}"\nversion = "${entry.vers}"\nedition = "2021"\n`
      + `links = "${entry.links}"\nbuild = "build.rs"\n`, true);
    archives.set(`${entry.name}/${entry.vers}`, bytes);
    checksums.set(`${entry.name}@${entry.vers}`, hash(bytes));
  }
  let indexes = new Map<string, string>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/index/config.json') return Response.json({ dl: `http://127.0.0.1:${server.port}/crates` });
    const index = indexes.get(path);
    if (index) return new Response(index);
    const match = /^\/crates\/([^/]+)\/([^/]+)\/download$/.exec(path);
    const archive = match ? archives.get(`${match[1]}/${match[2]}`) : null;
    return archive ? new Response(archive) : new Response('not found', { status: 404 });
  } });
  const nativeSource = `sparse+http://127.0.0.1:${server.port}/index/`;
  const admittedSource = `sparse+${registry}`;
  const run = async (kind: string, manifest: string, lock: string | null) => {
    const project = resolve(directory, kind, 'root');
    const home = resolve(directory, kind, 'cargo-home');
    await mkdir(resolve(project, 'src'), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(resolve(home, 'config.toml'), `[registries.snapshot]\nindex = "${nativeSource}"\n`);
    await writeFile(resolve(project, 'Cargo.toml'), manifest);
    await writeFile(resolve(project, 'src/lib.rs'), 'pub fn fixture() {}\n');
    if (lock !== null) await writeFile(resolve(project, 'Cargo.lock'), lock);
    const child = Bun.spawn([cargo, 'metadata', '--format-version', '1',
      '--manifest-path', resolve(project, 'Cargo.toml')], { cwd: project,
      env: { ...Bun.env, CARGO_HOME: home, CARGO_TARGET_DIR: resolve(directory, kind, 'target'),
        CARGO_NET_RETRY: '0', CARGO_HTTP_TIMEOUT: '10' }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    return { manifest, inputLock: lock, exitCode, stderr,
      metadata: stdout ? JSON.parse(stdout) as { packages: Array<{ id: string; name: string;
        version: string; source: string | null }>; resolve: { nodes: Array<{
          id: string; features: string[]; deps: Array<{ pkg: string;
            dep_kinds: Array<{ kind: string | null; target: string | null }> }> }> } } : null,
      outputLock: exitCode === 0 ? await readFile(resolve(project, 'Cargo.lock'), 'utf8') : null };
  };
  try {
    const results: Record<string, unknown> = {};
    // A bijective source-label substitution isolates the native network fixture.
    // Both request bytes and native bytes are retained; Main only receives the
    // admitted HTTPS sparse identity and never treats HTTP as an alias for it.
    for (const kind of ['seed', ...cargoLockCases] as const) {
      let request = cargoLockFixture(kind === 'seed' ? 'non-yanked' : kind);
      const entries = cargoIndexEntries(request).map(entry => ({ ...entry,
        cksum: checksums.get(`${entry.name}@${entry.vers}`)! }));
      request.indexFiles = request.indexFiles.map(file => cargoIndexFile(file.name,
        entries.filter(entry => entry.name === file.name)));
      indexes = new Map(request.indexFiles.map(file => [`/index/${indexPath(file.name)}`,
        Buffer.from(file.bytesBase64, 'base64').toString('utf8')]));
      let lock = request.existingLock ? Buffer.from(request.existingLock.bytesBase64, 'base64')
        .toString('utf8').replaceAll('a'.repeat(64), checksums.get('leaf@1.0.0')!)
        .replaceAll('b'.repeat(64), checksums.get('leaf@2.0.0')!) : null;
      if (kind === 'locked-yanked') {
        const generated = (results.seed as { native: { outputLock: string } }).native.outputLock
          .replaceAll(nativeSource, admittedSource);
        const expected = Bun.TOML.parse(lock!);
        if (JSON.stringify(Bun.TOML.parse(generated)) !== JSON.stringify(expected)) {
          throw new Error('fixture lock differs from native-generated seed');
        }
        lock = generated;
      }
      request = withCargoLock(request, lock);
      const native = await run(kind, Buffer.from(request.manifestBase64, 'base64').toString('utf8'),
        lock?.replaceAll(admittedSource, nativeSource) ?? null);
      const rezics = solveCargoSnapshot(request);
      const checksumFailure = ['changed-checksum', 'non-yanked-checksum-mismatch'].includes(kind);
      const yankedFailure = ['fresh-yanked', 'changed-requirement', 'changed-source',
        'missing-source', 'missing-lock-package'].includes(kind);
      const linksFailure = kind === 'links-conflict';
      const expectedStatus = checksumFailure ? 'inconsistent-source-data'
        : yankedFailure || linksFailure ? 'unsatisfiable' : 'solved';
      if (rezics.status !== expectedStatus || (native.exitCode === 0) !== (expectedStatus === 'solved')) {
        throw new Error(`${kind}: native/REZICS status differs: ${native.stderr} ${JSON.stringify(rezics)}`);
      }
      if (checksumFailure && !native.stderr.includes('changed between lock files')) {
        throw new Error(`${kind}: native failure was not a checksum mismatch`);
      }
      if (yankedFailure && !native.stderr.includes('is yanked')) throw new Error(`${kind}: ${native.stderr}`);
      if (linksFailure && !native.stderr.includes('links to the native library `native_shared`')) {
        throw new Error(`${kind}: ${native.stderr}`);
      }
      if (expectedStatus === 'solved') {
        const parsed = Bun.TOML.parse(native.outputLock!) as {
          package: Array<{ name: string; version: string; source?: string; checksum?: string }> };
        const selected = parsed.package.filter(item => item.source).map(item => {
          if (item.source !== nativeSource || item.checksum !== checksums.get(`${item.name}@${item.version}`)) {
            throw new Error(`${kind}: native lock source/checksum differs`);
          }
          return `${registry}#${item.name}@${item.version}`;
        }).sort();
        if (JSON.stringify(selected) !== JSON.stringify(rezics.selected.map(item => item.id))) {
          throw new Error(`${kind}: native lock selection differs`);
        }
        const identities = new Map(native.metadata!.packages.map(pkg => {
          if (pkg.source && pkg.source !== nativeSource) throw new Error(`${kind}: metadata source differs`);
          return [pkg.id, `${pkg.source ? registry : 'root'}#${pkg.name}@${pkg.version}`];
        }));
        const edges = native.metadata!.resolve.nodes.flatMap(node => node.deps.flatMap(dep =>
          dep.dep_kinds.map(edge => `${identities.get(node.id)}|${identities.get(dep.pkg)}|${edge.kind ?? 'normal'}|${edge.target ?? ''}`))).sort();
        const expectedEdges = rezics.edges.map(edge =>
          `${edge.from.replace(/#(?:host|target)$/, '')}|${edge.to.replace(/#(?:host|target)$/, '')}|${edge.kind}|${edge.target ?? ''}`).sort();
        if (JSON.stringify(edges) !== JSON.stringify(expectedEdges)) throw new Error(`${kind}: edges differ`);
        for (const node of native.metadata!.resolve.nodes) {
          const features = [...new Set(rezics.instances.filter(instance =>
            instance.id.replace(/#(?:host|target)$/, '') === identities.get(node.id))
            .flatMap(instance => instance.features))].sort();
          if (JSON.stringify(features) !== JSON.stringify([...node.features].sort())) {
            throw new Error(`${kind}: feature activation differs`);
          }
        }
        const expectedReuse = entries.filter(entry => entry.yanked && selected
          .includes(`${registry}#${entry.name}@${entry.vers}`)).map(entry => `${registry}#${entry.name}@${entry.vers}`).sort();
        if (JSON.stringify(expectedReuse) !== JSON.stringify(rezics.reusedYanked!.map(item => item.id))
          || rezics.reusedYanked!.some(item => item.lockSource !== admittedSource)) {
          throw new Error(`${kind}: yanked reuse witness differs`);
        }
      }
      results[kind] = { request, native, rezics };
    }
    const seedLock = (results.seed as { native: { outputLock: string } }).native.outputLock;
    for (const literal of ['4.0', '0x4', '+4']) {
      const inputLock = seedLock.replace('version = 4', `version = ${literal}`);
      const native = await run(`version-${literal.replaceAll('.', '_')}`,
        Buffer.from(cargoLockFixture().manifestBase64, 'base64').toString('utf8'),
        inputLock);
      const request = withCargoLock((results['locked-yanked'] as {
        request: ReturnType<typeof cargoLockFixture> }).request,
      inputLock.replaceAll(nativeSource, admittedSource));
      let rezics: ReturnType<typeof solveCargoSnapshot> | 'invalid-lock';
      try { rezics = solveCargoSnapshot(request); }
      catch (error) {
        if (!(error instanceof CargoResolutionInvalid)) throw error;
        rezics = 'invalid-lock';
      }
      if (literal === '4.0' ? native.exitCode === 0 || rezics !== 'invalid-lock'
        : native.exitCode !== 0 || rezics === 'invalid-lock' || rezics.status !== 'solved') {
        throw new Error(`Cargo lock version ${literal} classification differs`);
      }
      results[`version-${literal}`] = { request, native, rezics };
    }
    await writeFile(resolve(base, 'lock-result.json'), JSON.stringify({
      cargoVersion: '1.98.1', sourceMapping: { nativeSource, admittedSource }, results }, null, 2));
    console.log(`Cargo lock oracle matched ${cargoLockCases.length} eligibility and 3 format scenarios; result: ${resolve(base, 'lock-result.json')}`);
  } finally { server.stop(true); }
}
