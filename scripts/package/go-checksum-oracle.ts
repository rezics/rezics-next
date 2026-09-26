import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchGoProxyCapture, goModH1 } from
  '../../services/main/src/modules/package/go-proxy-capture.ts';
import { verifyGoSumdbTreeNote } from
  '../../services/main/src/modules/package/go-sumdb-note.ts';
import { fetchGoSumdbLatestEvidence, verifyGoSumdbLookup,
  verifyGoSumdbTreeConsistency } from
  '../../services/main/src/modules/package/go-sumdb-lookup.ts';
import { pinnedPseudoProvenance, verifyPseudoOracleBinding }
  from './go-checksum-provenance.ts';

async function checked(command: string[], cwd: string,
  env: Record<string, string | undefined> = process.env): Promise<string> {
  const proc = Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr}`);
  return stdout.trim();
}

const root = process.cwd();
const directory = resolve('.temp/package-go-checksum');
await mkdir(directory, { recursive: true });
await checked(['corepack', 'yarn', 'package:go-oracle'], root);
const tool = resolve('.temp/package-go-oracle/toolchain/go/bin/go');
const version = await checked([tool, 'version'], directory);
if (!version.includes('go1.27.1 linux/amd64')) throw new Error(`Go pin mismatch: ${version}`);
const env = { ...process.env, GOPROXY: 'https://proxy.golang.org',
  GOSUMDB: 'sum.golang.org', GOPRIVATE: '', GONOSUMDB: '', GONOPROXY: '',
  GOTOOLCHAIN: 'local', GOWORK: 'off', GO111MODULE: 'on', GOTELEMETRY: 'off',
  GOPATH: resolve(directory, 'gopath'), GOMODCACHE: resolve(directory, 'modcache'),
  GOCACHE: resolve(directory, 'cache'),
};
const officialManifest = await readFile(resolve('.temp/package-go-oracle/toolchain/go/src/cmd/go.mod'), 'utf8');
const officialSums = await readFile(resolve('.temp/package-go-oracle/toolchain/go/src/cmd/go.sum'), 'utf8');
const pseudoSource = pinnedPseudoProvenance(officialManifest, officialSums);
const modules = [{ path: 'golang.org/x/sync', version: 'v0.1.0',
  profile: 'go-module-proxy-capture-v1' as const },
{ path: pseudoSource.path, version: pseudoSource.version,
  profile: 'go-module-proxy-capture-v2' as const }];
const observations = [];
for (const module of modules) {
  const { path, version: moduleVersion, profile } = module;
  const captured = await fetchGoProxyCapture({ profile, path, version: moduleVersion });
  const native = JSON.parse(await checked([tool, 'mod', 'download', '-json',
    `${path}@${moduleVersion}`], directory, env)) as {
      Path: string; Version: string; Sum?: string; GoModSum?: string; Error?: string };
  const calculated = goModH1(captured.mod);
  if (native.Error || native.Path !== path || native.Version !== moduleVersion
    || !native.GoModSum || native.GoModSum !== calculated) {
    throw new Error(`Go checksum oracle diverged: ${JSON.stringify({
      error: native.Error, goModSum: native.GoModSum, calculated })}`);
  }
  const lookupBytes = await readFile(resolve(env.GOMODCACHE,
    `cache/download/sumdb/sum.golang.org/lookup/${path}@${moduleVersion}`));
  const marker = Buffer.from('\n\ngo.sum database tree\n');
  const treeAt = lookupBytes.indexOf(marker);
  if (treeAt < 0) throw new Error('native Go did not retain a signed lookup note');
  const signedTree = verifyGoSumdbTreeNote(lookupBytes.subarray(treeAt + 2));
  const includedLookup = await verifyGoSumdbLookup({ path, version: moduleVersion }, calculated);
  const latestHead = await fetchGoSumdbLatestEvidence();
  const latestTree = latestHead.tree;
  const consistencyTiles = latestTree.size < includedLookup.tree.size
    ? await verifyGoSumdbTreeConsistency(latestTree, includedLookup.tree)
    : await verifyGoSumdbTreeConsistency(includedLookup.tree, latestTree);
  const checkpointTree = latestTree.size < includedLookup.tree.size
    ? includedLookup.tree : latestTree;
  const pseudoManifestSha256 = profile === 'go-module-proxy-capture-v2'
    ? verifyPseudoOracleBinding(pseudoSource, captured, native, includedLookup) : null;
  const metadataCache = resolve(directory, 'metadata-only');
  const metadataEnv = { ...env, GOPATH: resolve(metadataCache, 'gopath'),
    GOMODCACHE: resolve(metadataCache, 'modcache'),
    GOCACHE: resolve(metadataCache, 'cache') };
  const metadata = JSON.parse(await checked([tool, 'list', '-m', '-json',
    `${path}@${moduleVersion}`], directory, metadataEnv)) as {
      Path: string; Version: string; GoModSum?: string; Sum?: string; Error?: string };
  const zipPath = resolve(metadataEnv.GOMODCACHE, `cache/download/${path}/@v/${moduleVersion}.zip`);
  let metadataZipDownloaded = false;
  try { await stat(zipPath); metadataZipDownloaded = true; } catch { /* no archive */ }
  observations.push({ module: `${path}@${moduleVersion}`, profile,
    officialPseudoSource: pseudoManifestSha256 ? {
      toolchainFile: 'go/src/cmd/go.mod', checksumFile: 'go/src/cmd/go.sum',
      ...pseudoSource, capturedManifestSha256: pseudoManifestSha256 } : null,
    capturedAt: captured.fetchedAt.toISOString(),
    infoSha256: await crypto.subtle.digest('SHA-256', captured.info)
      .then(bytes => Buffer.from(bytes).toString('hex')),
    rawModSha256: await crypto.subtle.digest('SHA-256', captured.mod)
      .then(bytes => Buffer.from(bytes).toString('hex')),
    calculatedGoModH1: calculated, nativeVerifiedGoModSum: native.GoModSum,
    nativeVerifiedModuleSum: native.Sum, signedTree, includedLookup,
    latestTree, latestSignedNoteBase64: latestHead.signedNoteBase64,
    checkpointTree,
    consistencyTiles,
    metadataOnly: { goModSum: metadata.GoModSum ?? null,
      moduleSum: metadata.Sum ?? null, zipDownloaded: metadataZipDownloaded,
      error: metadata.Error ?? null },
    checksumDatabase: 'sum.golang.org', proxy: 'proxy.golang.org' });
}
const result = { tool: version, observations };
await writeFile(resolve(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
