import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { solveGoMvsSnapshot, type GoMvsSnapshotRequest } from
  '../../services/main/src/modules/package/go-mvs.ts';

const VERSION = '1.27.1';
const ARCHIVE_SHA256 = '63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445';
const base = resolve('.temp/package-go-oracle');
const archive = resolve(base, `go${VERSION}.linux-amd64.tar.gz`);
const tool = resolve(base, 'toolchain/go/bin/go');

const fixture: GoMvsSnapshotRequest = {
  profile: 'go-mvs-stable-unpruned-v1', mainModule: 'example.com/main',
  goDirective: '1.16', coverage: { complete: true, unsupportedClauses: [] },
  roots: [
    { path: 'example.com/a', version: 'v1.2.0' },
    { path: 'example.com/b', version: 'v1.2.0' },
    { path: 'example.com/compat/v2', version: 'v2.1.0' },
  ],
  releases: [
    { path: 'example.com/a', version: 'v1.2.0', requirements: [
      { path: 'example.com/c', version: 'v1.3.0' }] },
    { path: 'example.com/b', version: 'v1.2.0', requirements: [
      { path: 'example.com/c', version: 'v1.4.0' }] },
    { path: 'example.com/c', version: 'v1.3.0', requirements: [
      { path: 'example.com/d', version: 'v1.2.0' }] },
    { path: 'example.com/c', version: 'v1.4.0', requirements: [
      { path: 'example.com/e', version: 'v1.1.0' }] },
    { path: 'example.com/d', version: 'v1.2.0', requirements: [] },
    { path: 'example.com/d', version: 'v1.9.0', requirements: [] },
    { path: 'example.com/e', version: 'v1.1.0', requirements: [] },
    { path: 'example.com/compat/v2', version: 'v2.1.0', requirements: [] },
  ],
};

async function checked(command: string[], cwd = process.cwd(), env = process.env): Promise<string> {
  const proc = Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr}`);
  return stdout.trim();
}

async function ensureTool(): Promise<void> {
  await mkdir(base, { recursive: true });
  try { await stat(archive); } catch {
    const response = await fetch(`https://go.dev/dl/go${VERSION}.linux-amd64.tar.gz`);
    if (!response.ok) throw new Error(`Go archive download returned ${response.status}`);
    await Bun.write(archive, response);
  }
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (hash !== ARCHIVE_SHA256) throw new Error(`Go archive SHA-256 mismatch: ${hash}`);
  try { await stat(tool); } catch {
    await checked(['python3', 'scripts/package/extract-go.py', archive,
      resolve(base, 'toolchain')]);
  }
  const actual = await checked([tool, 'version']);
  if (!actual.includes(`go${VERSION} linux/amd64`)) {
    throw new Error(`Go version mismatch: ${actual}`);
  }
}

function goMod(path: string, requirements: Array<{ path: string; version: string }>): string {
  return `module ${path}\n\ngo 1.16\n${requirements.length ?
    `\nrequire (\n${requirements.map(item => `\t${item.path} ${item.version}`).join('\n')}\n)\n`
    : ''}`;
}

async function main(): Promise<void> {
  const outcome = solveGoMvsSnapshot(fixture);
  if (outcome.status !== 'solved') throw new Error(`REZICS outcome: ${outcome.status}`);
  await ensureTool();
  const fixtureDir = resolve(base, 'fixture');
  await rm(fixtureDir, { recursive: true, force: true });
  const proxy = resolve(fixtureDir, 'proxy');
  const project = resolve(fixtureDir, 'main');
  await mkdir(project, { recursive: true });
  await writeFile(resolve(project, 'go.mod'), goMod(fixture.mainModule, fixture.roots));
  for (const release of fixture.releases) {
    const directory = resolve(proxy, release.path, '@v');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `${release.version}.mod`),
      goMod(release.path, release.requirements));
    await writeFile(resolve(directory, `${release.version}.info`),
      `${JSON.stringify({ Version: release.version, Time: '2020-01-01T00:00:00Z' })}\n`);
  }
  const env = { ...process.env,
    GOPROXY: `file://${proxy}`, GOSUMDB: 'off', GOTOOLCHAIN: 'local',
    GOWORK: 'off', GOPATH: resolve(fixtureDir, 'gopath'),
    GOMODCACHE: resolve(fixtureDir, 'modcache'), GOCACHE: resolve(fixtureDir, 'cache'),
    GOTELEMETRY: 'off',
  };
  const stdout = await checked([tool, 'list', '-mod=mod', '-m', 'all'], project, env);
  const native = stdout.split('\n').slice(1).map(line => {
    const [path, version] = line.split(' ');
    if (!path || !version) throw new Error(`Unexpected Go module line: ${line}`);
    return { path, version };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(native) !== JSON.stringify(outcome.buildList)) {
    throw new Error(`Native Go diverged: ${JSON.stringify({ native, rezics: outcome.buildList })}`);
  }
  const report = { tool: `go${VERSION}`, goDirective: fixture.goDirective,
    proxy: 'local file, no module network', native, rezics: outcome.buildList,
    loadedManifestCount: outcome.loadedManifestCount };
  await writeFile(resolve(base, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
