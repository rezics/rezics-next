import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { solveGoMvsSnapshot, type GoMvsSnapshotRequest } from
  '../../services/main/src/modules/package/go-mvs.ts';
import { parseGoModRequirements } from
  '../../services/main/src/modules/package/go-mod-parser.ts';

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
const directedFixture: GoMvsSnapshotRequest = {
  ...fixture, profile: 'go-mvs-stable-unpruned-main-directives-v2',
  releases: [...fixture.releases,
    { path: 'example.com/c', version: 'v1.5.0', requirements: [
      { path: 'example.com/f', version: 'v1.0.0' }] },
    { path: 'example.com/f', version: 'v1.0.0', requirements: [] }],
  mainDirectives: { exclusions: [{ path: 'example.com/c', version: 'v1.3.0' }],
    replacements: [{ original: { path: 'example.com/c', version: 'v1.4.0' },
      source: { path: 'example.com/c', version: 'v1.5.0' } }] },
};
const forkFixture: GoMvsSnapshotRequest = {
  ...directedFixture,
  releases: [...fixture.releases,
    { path: 'example.com/fork/c', version: 'v1.0.0',
      declaredModule: 'example.com/c', requirements: [
        { path: 'example.com/f', version: 'v1.0.0' }] },
    { path: 'example.com/f', version: 'v1.0.0', requirements: [] }],
  mainDirectives: { exclusions: [{ path: 'example.com/c', version: 'v1.3.0' }],
    replacements: [{ original: { path: 'example.com/c', version: 'v1.4.0' },
      source: { path: 'example.com/fork/c', version: 'v1.0.0' } }] },
};
const retractedFixture: GoMvsSnapshotRequest = {
  ...fixture, profile: 'go-mvs-stable-unpruned-main-directives-v2',
  releases: fixture.releases.map(item => item.path === 'example.com/d'
    && item.version === 'v1.9.0' ? { ...item, retractions: [
      { lower: 'v1.2.0', upper: 'v1.2.0', rationale: 'bad release' }] } : item),
  mainDirectives: { exclusions: [], replacements: [] },
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

function goMod(path: string, requirements: Array<{ path: string; version: string }>,
  directives?: GoMvsSnapshotRequest['mainDirectives'],
  retractions?: Array<{ lower: string; upper: string; rationale: string }>): string {
  return `module ${path}\n\ngo 1.16\n${requirements.length ?
    `\nrequire (\n${requirements.map(item => `\t${item.path} ${item.version}`).join('\n')}\n)\n`
    : ''}${(directives?.exclusions ?? []).map(item =>
    `exclude ${item.path} ${item.version}\n`).join('')}${(directives?.replacements ?? []).map(item =>
    `replace ${item.original.path} ${item.original.version} => ${item.source.path} ${item.source.version}\n`).join('')}${(retractions ?? []).map(item =>
    `retract ${item.lower === item.upper ? item.lower : `[${item.lower}, ${item.upper}]`} // ${item.rationale}\n`).join('')}`;
}

async function runScenario(name: string, request: GoMvsSnapshotRequest) {
  const outcome = solveGoMvsSnapshot(request);
  if (outcome.status !== 'solved') throw new Error(`REZICS outcome: ${outcome.status}`);
  const fixtureDir = resolve(base, name);
  await rm(fixtureDir, { recursive: true, force: true });
  const proxy = resolve(fixtureDir, 'proxy');
  const project = resolve(fixtureDir, 'main');
  await mkdir(project, { recursive: true });
  await writeFile(resolve(project, 'go.mod'), goMod(request.mainModule, request.roots,
    request.mainDirectives));
  const versions = new Map<string, string[]>();
  for (const release of request.releases) {
    const directory = resolve(proxy, release.path, '@v');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `${release.version}.mod`),
      goMod(release.declaredModule ?? release.path, release.requirements,
        undefined, release.retractions));
    await writeFile(resolve(directory, `${release.version}.info`),
      `${JSON.stringify({ Version: release.version, Time: '2020-01-01T00:00:00Z' })}\n`);
    versions.set(release.path, [...(versions.get(release.path) ?? []), release.version]);
  }
  for (const [path, available] of versions) {
    await writeFile(resolve(proxy, path, '@v/list'), `${available.join('\n')}\n`);
  }
  const env = { ...process.env,
    GOPROXY: `file://${proxy}`, GOSUMDB: 'off', GOTOOLCHAIN: 'local',
    GOWORK: 'off', GOPATH: resolve(fixtureDir, 'gopath'),
    GOMODCACHE: resolve(fixtureDir, 'modcache'), GOCACHE: resolve(fixtureDir, 'cache'),
    GOTELEMETRY: 'off',
  };
  if (name === 'baseline') {
    const modPath = resolve(project, 'go.mod');
    const parsed = parseGoModRequirements(await readFile(modPath, 'utf8'), request.mainModule);
    const nativeMod = JSON.parse(await checked([tool, 'mod', 'edit', '-json', modPath],
      project, env)) as { Module: { Path: string }; Go: string;
      Require: Array<{ Path: string; Version: string }> };
    const nativeRequirements = nativeMod.Require.map(item => ({
      path: item.Path, version: item.Version }));
    if (parsed.status !== 'parsed' || parsed.declaredModule !== nativeMod.Module.Path
      || parsed.goDirective !== nativeMod.Go
      || JSON.stringify(parsed.requirements) !== JSON.stringify(nativeRequirements)) {
      throw new Error(`Go manifest parser diverged: ${JSON.stringify({
        parsed, nativeMod })}`);
    }
  }
  const stdout = await checked([tool, 'list', '-mod=mod', '-m', 'all'], project, env);
  const nativeSources: Array<{ original: { path: string; version: string };
    source: { path: string; version: string } }> = [];
  const native = stdout.split('\n').slice(1).map(line => {
    const [path, version, arrow, sourcePath, sourceVersion] = line.split(' ');
    if (!path || !version) throw new Error(`Unexpected Go module line: ${line}`);
    if (arrow === '=>' && sourcePath && sourceVersion) {
      nativeSources.push({ original: { path, version },
        source: { path: sourcePath, version: sourceVersion } });
    } else if (arrow) throw new Error(`Unexpected Go replacement line: ${line}`);
    return { path, version };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(native) !== JSON.stringify(outcome.buildList)) {
    throw new Error(`Native Go diverged: ${JSON.stringify({ native, rezics: outcome.buildList })}`);
  }
  if (JSON.stringify(nativeSources) !== JSON.stringify(outcome.selectedSources ?? [])) {
    throw new Error(`Native Go replacement diverged: ${JSON.stringify({
      nativeSources, rezics: outcome.selectedSources })}`);
  }
  let nativeRetraction: string[] = [];
  if (name === 'retracted') {
    const detail = JSON.parse(await checked([tool, 'list', '-mod=mod', '-m', '-u',
      '-json', 'example.com/d'], project, env)) as { Retracted?: string[] };
    nativeRetraction = detail.Retracted ?? [];
    if (JSON.stringify(nativeRetraction) !== JSON.stringify(
      outcome.retractedSelected?.map(item => item.rationale) ?? [])) {
      throw new Error(`Native Go retraction diverged: ${JSON.stringify({
        nativeRetraction, rezics: outcome.retractedSelected })}`);
    }
  }
  return { name, goDirective: request.goDirective, native,
    rezics: outcome.buildList, nativeSources, nativeRetraction,
    loadedManifestCount: outcome.loadedManifestCount };
}

async function main(): Promise<void> {
  await ensureTool();
  const report = { tool: `go${VERSION}`, proxy: 'local file, no module network',
    scenarios: [await runScenario('baseline', fixture),
      await runScenario('main-directives', directedFixture),
      await runScenario('fork-replacement', forkFixture),
      await runScenario('retracted', retractedFixture)] };
  await writeFile(resolve(base, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
