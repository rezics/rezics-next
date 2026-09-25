import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchGoProxyCapture, goModH1 } from
  '../../services/main/src/modules/package/go-proxy-capture.ts';
import { verifyGoSumdbTreeNote } from
  '../../services/main/src/modules/package/go-sumdb-note.ts';
import { fetchGoSumdbLatest, verifyGoSumdbLookup,
  verifyGoSumdbTreeConsistency } from
  '../../services/main/src/modules/package/go-sumdb-lookup.ts';

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
const path = 'golang.org/x/sync';
const moduleVersion = 'v0.1.0';
const captured = await fetchGoProxyCapture({
  profile: 'go-module-proxy-capture-v1', path, version: moduleVersion });
const env = { ...process.env, GOPROXY: 'https://proxy.golang.org',
  GOSUMDB: 'sum.golang.org', GOPRIVATE: '', GONOSUMDB: '', GONOPROXY: '',
  GOTOOLCHAIN: 'local', GOWORK: 'off', GO111MODULE: 'on', GOTELEMETRY: 'off',
  GOPATH: resolve(directory, 'gopath'), GOMODCACHE: resolve(directory, 'modcache'),
  GOCACHE: resolve(directory, 'cache'),
};
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
const latestTree = await fetchGoSumdbLatest();
const consistencyTiles = await verifyGoSumdbTreeConsistency(includedLookup.tree,
  latestTree);
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
const result = { tool: version, module: `${path}@${moduleVersion}`,
  capturedAt: captured.fetchedAt.toISOString(),
  rawModSha256: await crypto.subtle.digest('SHA-256', captured.mod)
    .then(bytes => Buffer.from(bytes).toString('hex')),
  calculatedGoModH1: calculated, nativeVerifiedGoModSum: native.GoModSum,
  nativeVerifiedModuleSum: native.Sum, signedTree, includedLookup,
  latestTree, consistencyTiles,
  metadataOnly: { goModSum: metadata.GoModSum ?? null,
    moduleSum: metadata.Sum ?? null, zipDownloaded: metadataZipDownloaded,
    error: metadata.Error ?? null },
  checksumDatabase: 'sum.golang.org', proxy: 'proxy.golang.org' };
await writeFile(resolve(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
