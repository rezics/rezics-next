import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchGoProxyCapture, goModH1 } from
  '../../services/main/src/modules/package/go-proxy-capture.ts';

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
const result = { tool: version, module: `${path}@${moduleVersion}`,
  capturedAt: captured.fetchedAt.toISOString(),
  rawModSha256: await crypto.subtle.digest('SHA-256', captured.mod)
    .then(bytes => Buffer.from(bytes).toString('hex')),
  calculatedGoModH1: calculated, nativeVerifiedGoModSum: native.GoModSum,
  nativeVerifiedModuleSum: native.Sum,
  checksumDatabase: 'sum.golang.org', proxy: 'proxy.golang.org' };
await writeFile(resolve(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
